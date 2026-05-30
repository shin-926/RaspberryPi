// Phase D 検証: 生成した docx を Henry 患者ファイルへ実アップロードする。
// 安全装置:
//   - patientUuid は引数必須（既定値なし。誤爆防止）
//   - 実際の書き込みは `--confirm` 指定時のみ。未指定なら docx 生成までで停止
//   - タイトルは「_AIテスト」を付与し、後から見つけて削除しやすくする
import {
  getPatient,
  getTargetHospitalization,
  fetchMainDisease,
  fetchClinicalRecords,
  fetchCalendarData,
} from './collect.ts';
import { formatCalendarForPrompt, buildPromptMarkdown } from './prompt.ts';
import { callGeminiProxy, fetchDischargeDestination } from './generate.ts';
import { buildReplacements, getTodayYYYYMMDD } from './docfields.ts';
import { renderDischargeSummaryDocx } from './google-docs.ts';
import { uploadDocxToHenry } from './henry-upload.ts';

const PATIENT_UUID = process.argv[2];
const CONFIRM = process.argv.includes('--confirm');

async function main(): Promise<void> {
  if (!PATIENT_UUID || !/^[0-9a-f-]{36}$/i.test(PATIENT_UUID)) {
    throw new Error('使い方: tsx src/verify-upload.ts <patientUuid> [--confirm]');
  }

  const [patient, hosp] = await Promise.all([getPatient(PATIENT_UUID), getTargetHospitalization(PATIENT_UUID)]);
  if (!patient || !hosp) throw new Error('患者または入院情報の取得に失敗');

  const hospStartDate = new Date(hosp.startDate.year, (hosp.startDate.month || 1) - 1, hosp.startDate.day || 1);
  const [disease, records, calendarData] = await Promise.all([
    fetchMainDisease(PATIENT_UUID),
    fetchClinicalRecords(PATIENT_UUID),
    fetchCalendarData(PATIENT_UUID, hospStartDate),
  ]);

  const calendar = formatCalendarForPrompt(calendarData);
  const promptMarkdown = buildPromptMarkdown(
    patient, hosp, disease, records.profile, records.doctorRecords, records.nursingRecords, calendar,
  );
  const [dischargeDestination, ai] = await Promise.all([
    fetchDischargeDestination(patient.fullName, hosp.endDate, patient.serialNumber || ''),
    callGeminiProxy(promptMarkdown),
  ]);

  const replacements = buildReplacements(patient, hosp, ai, dischargeDestination, calendar.dischargePrescriptions);
  // 検証用タイトル（本番は dischargeSummaryFileName() の "YYYYMMDD_退院サマリー"）
  const title = `${getTodayYYYYMMDD()}_退院サマリー_AIテスト`;

  console.log('[verify-upload] docx 生成中...');
  const docxBytes = await renderDischargeSummaryDocx(title, replacements);
  console.log(`[verify-upload] docx 生成完了 (${docxBytes.length} bytes), タイトル: ${title}`);

  if (!CONFIRM) {
    console.log('[verify-upload] --confirm 未指定のため、カルテへの書き込みは行いません（ここで停止）。');
    console.log('[verify-upload] 実アップロードするには末尾に --confirm を付けて再実行してください。');
    return;
  }

  console.log(`[verify-upload] カルテへアップロードします（patient=${PATIENT_UUID.slice(0, 8)}…）...`);
  const fileUuid = await uploadDocxToHenry(PATIENT_UUID, docxBytes, title, null);
  console.log(`[verify-upload] アップロード完了。patientFileUuid=${fileUuid}`);
  console.log(`[verify-upload] Henryのこの患者の「ファイル」に「${title}」が追加されています。確認後、不要なら削除してください。`);
}

main().catch((e) => {
  console.error('[verify-upload] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
