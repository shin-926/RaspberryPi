// DPC連絡表自動生成→FL00001形式テキスト出力 CLI
//
// 使い方:
//   既存FF1+Knを「正解の患者リスト」として使い、Henry+LLMで再生成して FL00001 として出力
//
//   npx tsx src/generate-renraku-ff1.ts \
//     --ff1 _in/FF1_xxx.txt --kn _in/Kn_xxx.csv \
//     --output _out/renraku-fl00001-202510.txt
//
//   (--ff1/--kn の代わりに --detect を使えば、直近 N日の退院者をdetectから取得することも将来可能)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { query } from './graphql.ts';
import { getHospitalizationByAdmissionDate } from './collect.ts';
import { generateRenrakuForms } from './renraku.ts';
import { parseFF1File } from './ff1-parser.ts';
import { parseKnFile, indexKnByPatientKey, attachIdentity } from './kn-parser.ts';
import { bundleToFL00001Row, emitFL00001, type FL00001SupplementaryInfo } from './ff1-fl00001-emitter.ts';
import {
  fetchOrganizationDoctors,
  findDepartmentByDoctorName,
  departmentToDpcCode,
} from './renraku-collect.ts';
import type { DischargeTarget } from './detect.ts';

const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const i = argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const FF1_PATH = arg('ff1');
const KN_PATH = arg('kn');
const OUTPUT = arg('output');
const MAX = Number(arg('max')) || Number.MAX_SAFE_INTEGER;

if (!FF1_PATH || !KN_PATH || !OUTPUT) {
  console.error('Usage: generate-renraku-ff1.ts --ff1 <FF1.txt> --kn <Kn.csv> --output <out.txt> [--max <N>]');
  process.exit(2);
}

// ============================================================
// Henry検索（カナ＋生年月日）
// ============================================================
const Q_SEARCH = `
  query ListPatientsV2($input: ListPatientsV2RequestInput!) {
    listPatientsV2(input: $input) {
      entries {
        patient {
          uuid
          serialNumber
          fullName
          fullNamePhonetic
          detail {
            sexType
            birthDate { year month day }
            postalCode
          }
        }
      }
    }
  }`;

interface HenryHit {
  uuid: string;
  serialNumber: string;
  fullName: string;
  fullNamePhonetic: string;
  birthDateIso: string;
  sex: '男' | '女' | '不明';
  postalCode: string;
}

async function findHenry(kana: string, birth: string, sex: '男' | '女' | '不明'): Promise<HenryHit | null> {
  const data = await query<{
    listPatientsV2?: {
      entries?: Array<{
        patient?: {
          uuid: string;
          serialNumber: string;
          fullName: string;
          fullNamePhonetic: string;
          detail?: { sexType?: string; birthDate?: { year: number; month: number; day: number }; postalCode?: string };
        };
      }>;
    };
  }>(Q_SEARCH, {
    input: {
      generalFilter: { query: kana, patientCareType: 'PATIENT_CARE_TYPE_ANY' },
      hospitalizationFilter: { doctorUuid: null, roomUuids: [], wardUuids: [], states: [], onlyLatest: true },
      sorts: [],
      pageSize: 20,
      pageToken: '',
    },
  });
  const entries = data.listPatientsV2?.entries || [];
  const candidates: HenryHit[] = entries
    .filter((e) => e.patient?.uuid)
    .map((e) => {
      const p = e.patient!;
      const bd = p.detail?.birthDate;
      return {
        uuid: p.uuid,
        serialNumber: p.serialNumber,
        fullName: p.fullName,
        fullNamePhonetic: p.fullNamePhonetic,
        birthDateIso: bd ? `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}` : '',
        sex: p.detail?.sexType?.includes('FEMALE') ? '女' : p.detail?.sexType?.includes('MALE') ? '男' : '不明',
        postalCode: p.detail?.postalCode || '',
      };
    });
  const byBirth = candidates.filter((c) => c.birthDateIso === birth);
  if (byBirth.length === 1) return byBirth[0];
  const bySex = byBirth.filter((c) => c.sex === sex);
  return bySex[0] || byBirth[0] || null;
}

// ============================================================
// メイン
// ============================================================
async function main(): Promise<void> {
  const started = new Date();
  console.log(`[generate-ff1] FF1パース中: ${FF1_PATH}`);
  const ff1Patients = parseFF1File(FF1_PATH!);
  const knRecords = parseKnFile(KN_PATH!);
  const knByKey = indexKnByPatientKey(knRecords);
  const withIdentity = attachIdentity(ff1Patients, knByKey);

  // マオカ病院の医師→診療科マッピングを取得（FF1の診療科コード判定用）
  const doctors = await fetchOrganizationDoctors();

  const discharged = withIdentity.filter((p) => p.dischargeDate);
  console.log(`[generate-ff1] 退院済み: ${discharged.length}件 / 在院中スキップ: ${withIdentity.length - discharged.length}件`);

  const targets = discharged.slice(0, MAX);
  const rows: Array<ReturnType<typeof bundleToFL00001Row>> = [];
  let ok = 0;
  let failed = 0;

  for (const ff1 of targets) {
    const label = ff1.dataIdentifier;
    try {
      if (!ff1.kanaName) {
        console.warn(`[generate-ff1] Kn未突合スキップ: ${label}`);
        failed++;
        continue;
      }
      const henry = await findHenry(ff1.kanaName, ff1.birthDate, ff1.sex);
      if (!henry) {
        console.warn(`[generate-ff1] Henry未解決: ${label} ${ff1.kanaName}`);
        failed++;
        continue;
      }

      const target: DischargeTarget = {
        patientUuid: henry.uuid,
        serialNumber: henry.serialNumber,
        fullName: henry.fullName,
        fullNamePhonetic: henry.fullNamePhonetic,
        birthDate: null,
        sexType: '',
        admissionDate: null,
        dischargeDate: null,
        doctorName: '',
      };

      const bundle = await generateRenrakuForms(target, { admissionDateIso: ff1.admissionDate });
      if (!bundle) {
        console.warn(`[generate-ff1] 生成失敗: ${label}`);
        failed++;
        continue;
      }

      // 主治医名→診療科コード判定（FF1 a2フィールド用）
      const hosp = await getHospitalizationByAdmissionDate(henry.uuid, ff1.admissionDate);
      const doctorName = hosp?.hospitalizationDoctor?.doctor?.name || '';
      const deptName = findDepartmentByDoctorName(doctors, doctorName);
      const deptCode = deptName ? departmentToDpcCode(deptName) : '120';

      // 病棟（一般 vs 療養）判定: Henryのward.nameに「療養」が含まれるか
      const wardName = hosp?.lastHospitalizationLocation?.ward?.name || '';
      const isRyoyo = /療養/.test(wardName);

      const supp: FL00001SupplementaryInfo = {
        dataIdentifier: ff1.dataIdentifier,
        birthDate: ff1.birthDate,
        sex: ff1.sex === '不明' ? '男' : ff1.sex,
        postalCode: henry.postalCode,
        departmentCode: deptCode,
        wardCode: '',  // a9は空でも入力支援ソフトでマスタ補完される
        wardKind: isRyoyo ? 'ryoyo' : 'ippan',
        doctorName,
      };
      console.log(
        `  ↳ 主治医: ${doctorName || '(不明)'} → 診療科: ${deptName || '?'} (${deptCode}) / 病棟: ${wardName} → ${isRyoyo ? '療養' : '一般'}`,
      );
      const row = bundleToFL00001Row(bundle, supp);
      rows.push(row);
      ok++;
      console.log(`[generate-ff1] (${ok + failed}/${targets.length}) OK: ${label}`);
    } catch (e) {
      console.error(`[generate-ff1] 失敗: ${label}:`, e instanceof Error ? e.message : e);
      failed++;
    }
  }

  // FL00001 を SHIFT-JIS でファイル出力
  const buf = emitFL00001(rows);
  mkdirSync(dirname(OUTPUT!), { recursive: true });
  writeFileSync(OUTPUT!, buf);

  const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
  console.log(`\n[generate-ff1] 完了 (${elapsed}s) 成功${ok} 失敗${failed}`);
  console.log(`  出力: ${OUTPUT} (${buf.length}バイト、SHIFT-JIS、タブ区切り)`);
  console.log(`  この .txt を DPCデータ入力支援ソフトの「登録データファイル取り込み」(FL00001)で取り込んでください`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[generate-ff1] FATAL:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
