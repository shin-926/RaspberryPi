// Google Docs テンプレートのプレースホルダ置換マップを構築する。
// henry_discharge_summary.ts L957-978 の replacements と同一。
import { calculateAge, genderText } from './collect.ts';
import type { HenryDate, HenryPatient, HenryHospitalization, AiResult } from './types.ts';

/** JSTの YYYYMMDD（henry_form_commons.ts getTodayYYYYMMDD と同一） */
export function getTodayYYYYMMDD(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** カルテ保存時のファイル名（拡張 generateDoc のデフォルトと同一: YYYYMMDD_退院サマリー） */
export function dischargeSummaryFileName(): string {
  return `${getTodayYYYYMMDD()}_退院サマリー`;
}

function formatHenryDateJP(d: HenryDate | null): string {
  if (!d || !d.year) return '';
  if (!d.month || !d.day) return `${d.year}年`;
  return `${d.year}年${d.month}月${d.day}日`;
}

/** カタカナ→ひらがな（HenryFormCommons.utils.katakanaToHiragana 相当） */
function katakanaToHiragana(s: string): string {
  if (!s) return '';
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function buildReplacements(
  patient: HenryPatient,
  hosp: HenryHospitalization,
  ai: AiResult,
  dischargeDestination: string,
  dischargePrescriptions: string,
): Record<string, string> {
  const age = calculateAge(patient.detail?.birthDate ?? null);
  const today = new Date();
  return {
    '{{作成日}}': `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`,
    '{{氏名}}': patient.fullName || '',
    '{{ID}}': patient.serialNumber || '',
    '{{生年月日}}': formatHenryDateJP(patient.detail?.birthDate ?? null),
    '{{年齢}}': age != null ? `${age}歳` : '',
    '{{性別}}': genderText(patient.detail?.sexType || ''),
    '{{しめい}}': katakanaToHiragana(patient.fullNamePhonetic || ''),
    '{{住所}}': patient.detail?.addressLine_1 || '',
    '{{電話番号}}': patient.detail?.phoneNumber || '',
    '{{担当医}}': hosp.hospitalizationDoctor?.doctor?.name || '',
    '{{入院日}}': formatHenryDateJP(hosp.startDate),
    '{{退院日}}': formatHenryDateJP(hosp.endDate ?? null),
    '{{退院先}}': dischargeDestination,
    '{{主訴}}': ai.chiefComplaint,
    '{{現病歴}}': ai.presentIllness,
    '{{既往歴}}': ai.pastHistory,
    '{{入院時所見}}': ai.admissionFindings,
    '{{入院経過}}': ai.progress,
    '{{退院後の方針}}': ai.plan,
    '{{退院時処方}}': dischargePrescriptions || 'なし',
  };
}
