// 指定したFF1患者番号のプロンプトを構築してファイルに出力するだけのユーティリティ。
// LLM呼び出しは行わない。Claude等で手動判定したい時に使う。
//
// 使い方:
//   npx tsx src/dump-renraku-prompt.ts \
//     --ff1 _in/FF1_xxx.txt --kn _in/Kn_xxx.csv \
//     --data-identifier 0000007481 \
//     --output _out/prompt-07481.md
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { query } from './graphql.ts';
import { getPatient, getHospitalizationByAdmissionDate, fetchClinicalRecords, formatHenryDate } from './collect.ts';
import {
  fetchAllDiseases,
  fetchFullCalendar,
  fetchRehabRecords,
  fetchSharedInfo,
} from './renraku-collect.ts';
import { classifyDiseases } from './renraku-decide.ts';
import { buildRenrakuPrompt } from './renraku-prompt.ts';
import { parseFF1File } from './ff1-parser.ts';
import { parseKnFile, indexKnByPatientKey, attachIdentity } from './kn-parser.ts';

const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const i = argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const FF1 = arg('ff1');
const KN = arg('kn');
const DATA_ID = arg('data-identifier');
const OUTPUT = arg('output');
if (!FF1 || !KN || !DATA_ID || !OUTPUT) {
  console.error('Usage: dump-renraku-prompt.ts --ff1 <FF1.txt> --kn <Kn.csv> --data-identifier <id> --output <out.md>');
  process.exit(2);
}

const Q_SEARCH = `
  query ListPatientsV2($input: ListPatientsV2RequestInput!) {
    listPatientsV2(input: $input) {
      entries { patient { uuid serialNumber fullName fullNamePhonetic detail { sexType birthDate { year month day } } } }
    }
  }`;

async function findHenry(kana: string, birthDate: string, sex: string): Promise<string | null> {
  const data = await query<{ listPatientsV2?: { entries?: Array<{ patient?: { uuid: string; serialNumber: string; detail?: { sexType?: string; birthDate?: { year: number; month: number; day: number } } } }> } }>(Q_SEARCH, {
    input: { generalFilter: { query: kana, patientCareType: 'PATIENT_CARE_TYPE_ANY' }, hospitalizationFilter: { doctorUuid: null, roomUuids: [], wardUuids: [], states: [], onlyLatest: true }, sorts: [], pageSize: 20, pageToken: '' },
  });
  const entries = data.listPatientsV2?.entries || [];
  const match = entries.find((e) => {
    const bd = e.patient?.detail?.birthDate;
    if (!bd) return false;
    const iso = `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`;
    return iso === birthDate;
  });
  return match?.patient?.uuid || null;
}

async function main(): Promise<void> {
  const ff1 = parseFF1File(FF1!);
  const kn = parseKnFile(KN!);
  const knMap = indexKnByPatientKey(kn);
  const withIdentity = attachIdentity(ff1, knMap);
  const target = withIdentity.find((p) => p.dataIdentifier === DATA_ID);
  if (!target) {
    console.error(`データ識別番号 ${DATA_ID} がFF1に見つかりません`);
    process.exit(1);
  }
  console.log(`[dump] 対象患者: ${DATA_ID} ${target.kanaName} 入院日${target.admissionDate}`);

  const uuid = await findHenry(target.kanaName, target.birthDate, target.sex);
  if (!uuid) {
    console.error(`Henry患者が見つかりません: ${target.kanaName} ${target.birthDate}`);
    process.exit(1);
  }
  console.log(`[dump] Henry UUID: ${uuid}`);

  const [patient, hosp] = await Promise.all([getPatient(uuid), getHospitalizationByAdmissionDate(uuid, target.admissionDate)]);
  if (!patient || !hosp || !hosp.endDate) {
    console.error('患者/入院情報が取得できません');
    process.exit(1);
  }
  const admissionDate = new Date(hosp.startDate.year, hosp.startDate.month - 1, hosp.startDate.day);
  const dischargeDate = new Date(hosp.endDate.year, hosp.endDate.month - 1, hosp.endDate.day);
  const admissionIso = formatHenryDate(hosp.startDate);
  const dischargeIso = formatHenryDate(hosp.endDate);

  const [diseases, records, calendar, rehabRecords, sharedInfo] = await Promise.all([
    fetchAllDiseases(uuid),
    fetchClinicalRecords(uuid),
    fetchFullCalendar(uuid, admissionDate, dischargeDate),
    fetchRehabRecords(uuid),
    fetchSharedInfo(uuid),
  ]);

  const classified = classifyDiseases(diseases, admissionIso);

  const prompt = buildRenrakuPrompt({
    patient,
    hospitalization: hosp,
    diseasesBeforeOrAtAdmission: classified.beforeOrAtAdmission,
    diseasesAfterAdmission: classified.afterAdmission,
    diseasesAll: diseases,
    patientProfile: records.profile,
    doctorRecords: records.doctorRecords,
    nursingRecords: records.nursingRecords,
    rehabRecords,
    sharedInfo,
    vitalsSummary: '',
    notableLabValues: '',
  });

  mkdirSync(dirname(OUTPUT!), { recursive: true });
  // FF1の正解値も末尾に付ける（比較しやすいよう）
  const ff1Summary = `\n\n---\n# FF1正解値（参考）\n` + JSON.stringify({
    admissionPurpose: target.admissionPurpose,
    triggerDiseaseICD10: target.triggerDisease?.icd10,
    triggerDiseaseName: target.triggerDisease?.name,
    mainDiseaseICD10: target.mainDisease?.icd10,
    mainDiseaseName: target.mainDisease?.name,
    resourceDiseaseICD10: target.resourceDisease?.icd10,
    resourceDiseaseName: target.resourceDisease?.name,
    jcsAtAdmission: target.jcsAtAdmission,
    jcsAtDischarge: target.jcsAtDischarge,
    swallowingAtAdmission: target.swallowingAtAdmission,
    swallowingAtDischarge: target.swallowingAtDischarge,
    nutritionRoute5AtAdmission: target.nutritionRoute5AtAdmission,
    nutritionRoute5AtDischarge: target.nutritionRoute5AtDischarge,
    adlAtAdmission: target.adlAtAdmission,
    adlAtDischarge: target.adlAtDischarge,
    outcome: target.outcome,
    dischargeDestination: target.dischargeDestination,
    dementiaLevel: target.dementiaLevel,
    hasHomeMedicalBefore: target.hasHomeMedicalBefore,
    hasHomeMedicalAfter: target.hasHomeMedicalAfter,
  }, null, 2);

  writeFileSync(OUTPUT!, prompt + ff1Summary);
  console.log(`[dump] 完了: ${OUTPUT} (${prompt.length}文字)`);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
