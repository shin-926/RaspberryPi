// FF1 登録データ取込ファイル【FL00001】エミッタ
//
// 仕様: 「FF1登録データ取込ファイル定義書_2026.pdf」（PRRISM、2026年版）
// - 形式: タブ区切り、SHIFT-JIS、CRLF
// - 拡張子: .txt
// - ヘッダー: 1行目、ファイルヘッダー名（b1, c2, d100 等のコード）
// - データ: 2行目以降、1行=1患者入院
//
// マオカ病院（療養型）の必要項目のみ実装。手術・脳卒中急性期・がん等は対象外。
import iconv from 'iconv-lite';
import type { RenrakuFormBundle } from './renraku-types.ts';

// ============================================================
// FL00001 各列のヘッダコード（出力順序＝定義書記載順）
// ============================================================
const COLUMNS = [
  'b1',     // データ識別番号（10桁ゼロ埋め必須）
  'mpe1',   // 統括診療情報番号（"0"=親様式1）
  'c2',     // 入院年月日 YYYYMMDD
  'c4',     // 退院年月日 YYYYMMDD
  'a20',    // 様式1開始日
  'a21',    // 様式1終了日
  'c41',    // 回数管理番号
  'b4',     // 生年月日 YYYYMMDD
  'b3',     // 性別 1=男 2=女
  'b5',     // 患者住所地域の郵便番号
  'b2',     // 氏名
  'c3',     // 入院経路
  'c13',    // 他院よりの紹介の有無
  'c14',    // 自院の外来からの入院
  'c15',    // 予定・救急医療入院
  'c16',    // 救急車による搬送の有無
  'c42',    // 入院前の在宅医療の有無
  'd298',   // 自傷行為・自殺企図の有無
  'd399',   // 過去の自傷行為・自殺企図の有無
  'c5',     // 退院先
  'c7',     // 退院時転帰
  'c8',     // 入院から24時間以内の死亡の有無
  'c43',    // 退院後の在宅医療の有無
  'a2',     // 診療科コード
  'a3',     // 転科の有無
  'c25',    // 調査対象となる一般病棟への入院の有無
  'c26',    // 調査対象となる精神病棟への入院の有無
  'c27',    // その他の病棟への入院の有無
  'f39',    // 入院中の主な診療目的
  'f4',     // 治験実施の有無
  'c10',    // 前回退院年月日
  'c11',    // 前回同一傷病で自院入院の有無
  'c35',    // 再入院種別
  'c36',    // 再入院理由の種別
  'c37',    // 再入院理由自由記載欄
  'd162',   // 身長
  'd163',   // 入院時体重
  'd164',   // 退院時体重
  'd197',   // 認知症高齢者の日常生活自立度判定基準
  'd334',   // 要介護度
  'd414',   // 低栄養の有無（様式1開始日時点）
  'd415',   // 摂食・嚥下機能障害の有無（様式1開始日時点）
  'd416',   // 低栄養の有無（様式1終了日時点）
  'd417',   // 摂食・嚥下機能障害の有無（様式1終了日時点）
  'd418',   // 経管・経静脈栄養の状況（様式1開始日時点）
  'd419',   // 経管・経静脈栄養の状況（様式1終了日時点）
  'd100',   // 入院時ADLスコア（10桁）
  'd119',   // 退院時ADLスコア
  'f13',    // 入院時意識障害JCS
  'f128',   // 退院時意識障害JCS
  // 主傷病
  'd2',     // 主傷病_ICD10
  'd4',     // 主傷病_傷病名コード
  'd1',     // 主傷病_傷病名
  // 入院契機
  'd9',     // 入院契機_ICD10
  'd11',    // 入院契機_傷病名コード
  'd8',     // 入院契機_傷病名
  // 医療資源
  'd16',    // 医療資源_ICD10
  'd18',    // 医療資源_傷病名コード
  'd15',    // 医療資源_傷病名
  // 入院時併存症 1〜10
  'd30', 'd32', 'd29',
  'd37', 'd39', 'd36',
  'd44', 'd46', 'd43',
  'd51', 'd53', 'd50',
  'd199', 'd200', 'd198',
  'd207', 'd208', 'd206',
  'd215', 'd216', 'd214',
  'd223', 'd224', 'd222',
  'd231', 'd232', 'd230',
  'd239', 'd240', 'd238',
  // 入院後発症疾患 1〜10
  'd58', 'd60', 'd57',
  'd65', 'd67', 'd64',
  'd72', 'd74', 'd71',
  'd79', 'd81', 'd78',
  'd247', 'd248', 'd246',
  'd255', 'd256', 'd254',
  'd263', 'd264', 'd262',
  'd271', 'd272', 'd270',
  'd279', 'd280', 'd278',
  'd287', 'd288', 'd286',
  // 病棟
  'a9',     // 病棟コード（様式1）
  // 入院前生活復帰
  'd477',   // 入院前の生活の場への復帰の有無
] as const;

type ColumnKey = (typeof COLUMNS)[number];
type FL00001Row = Record<ColumnKey, string>;

// ============================================================
// 補助情報（bundleにない値を提供）
// ============================================================
export interface FL00001SupplementaryInfo {
  /** マオカ病院から付与する10桁データ識別番号（数字のみ） */
  dataIdentifier: string;
  /** 生年月日 YYYY-MM-DD */
  birthDate: string;
  /** 性別 '男' | '女' */
  sex: '男' | '女';
  /** 郵便番号（ハイフン込み可、emitter側で除去） */
  postalCode?: string;
  /** 診療科の提出用コード（マオカで主に整形外科=120、内科=010 など） */
  departmentCode?: string;
  /** 病棟コード（様式1の提出用） */
  wardCode?: string;
  /** 病棟種別 'ippan'=一般病棟 / 'ryoyo'=療養病棟 */
  wardKind?: 'ippan' | 'ryoyo';
  /** 前回退院年月日 YYYY-MM-DD（初回入院なら省略） */
  previousDischargeDate?: string | null;
  /** 主治医名（参考情報、ログ用） */
  doctorName?: string;
}

// ============================================================
// ユーティリティ
// ============================================================
function toYYYYMMDD(iso: string): string {
  if (!iso) return '';
  return iso.replace(/-/g, '');
}

function padLeft(s: string, n: number, ch: string): string {
  while (s.length < n) s = ch + s;
  return s;
}

function dementiaToCode(level: string): string {
  switch (level) {
    case '自立': return '0';
    case 'Ⅰ': return '1';
    case 'Ⅱa':
    case 'Ⅱb': return '2';
    case 'Ⅲa':
    case 'Ⅲb': return '3';
    case 'Ⅳ': return '4';
    case 'M': return '5';
    default: return '0';
  }
}

function admissionRouteToCode(value: string): string {
  if (!value) return '0';
  // 既にコード値（'0'-'9'）ならそのまま、説明文なら先頭文字を抜き出す
  const m = value.match(/^([0-9])/);
  return m ? m[1] : '0';
}

function dischargeDestinationToCode(value: string): string {
  if (!value) return '0';
  const m = value.match(/^([0-9a])/);
  return m ? m[1] : '0';
}

/** 体重を kg 形式に整形（定義書：小数点以下の入力がない場合「.0」を補填） */
function formatWeight(kg: number): string {
  // 整数なら ".0" を付与、小数なら小数第1位までに丸める
  if (Number.isInteger(kg)) return `${kg}.0`;
  return (Math.round(kg * 10) / 10).toFixed(1);
}

// ============================================================
// bundle → FL00001Row 変換
// ============================================================
export function bundleToFL00001Row(
  bundle: RenrakuFormBundle,
  supp: FL00001SupplementaryInfo,
): FL00001Row {
  // データ識別番号: 10桁ゼロ埋め、数字のみ
  const dataId = padLeft(supp.dataIdentifier.replace(/\D/g, ''), 10, '0');
  if (dataId.length !== 10) throw new Error(`データ識別番号は10桁: ${supp.dataIdentifier}`);

  const adm = bundle.doctorFormI_admission;
  const dis = bundle.doctorFormI_discharge;
  const nurseAdm = bundle.nurseFormAdmission;
  const nurseDis = bundle.nurseFormDischarge;

  const cYYYYMMDD_admission = toYYYYMMDD(bundle.admissionDate);
  const cYYYYMMDD_discharge = toYYYYMMDD(bundle.dischargeDate);

  // 病名（マスタコード=未登録なら "0000999"、ICDコード=正規ICD10）
  const mainD = dis.mainDisease;
  const triggerD = adm.triggerDisease.value;
  const resourceD = dis.resourceDisease.value;
  // ICD10ベースで重複除去
  //  - 主/契機/資源と同ICD10は併存症から除外
  //  - 主/契機/資源/採用された併存症と同ICD10は入院後発症から除外
  //  - 各リスト内のICD10重複も先頭優先で除去
  //  - ICD10が空のものはユニークID扱い（誤って1個に潰れないよう）
  const reservedIcds = new Set<string>(
    [mainD?.icd10, triggerD?.icd10, resourceD?.icd10].filter((c): c is string => !!c),
  );
  const dedupByIcd = (list: typeof bundle.doctorFormI_admissionExtras.comorbidities, reserved: Set<string>) => {
    const out: typeof list = [];
    const seen = new Set<string>(reserved);
    for (const d of list) {
      const k = d.icd10 || `__no-icd:${d.uuid || d.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
    return out;
  };
  const comorbid = dedupByIcd(bundle.doctorFormI_admissionExtras.comorbidities, reservedIcds).slice(0, 10);
  const postReserved = new Set<string>(reservedIcds);
  for (const c of comorbid) if (c.icd10) postReserved.add(c.icd10);
  const post = dedupByIcd(bundle.doctorFormI_admissionExtras.postAdmissionDiseases, postReserved).slice(0, 10);

  // 入院時/退院時ADL10桁（バリデーション済み前提）
  const adlAdm = nurseAdm.adlScoreAtAdmission.value.raw || '9999999999';
  const adlDis = nurseDis.adlScoreAtDischarge.value.raw || '9999999999';

  const row: FL00001Row = {
    b1: dataId,
    mpe1: '0', // 親様式1
    c2: cYYYYMMDD_admission,
    c4: cYYYYMMDD_discharge,
    a20: cYYYYMMDD_admission,
    a21: cYYYYMMDD_discharge,
    c41: '0',
    b4: toYYYYMMDD(supp.birthDate),
    b3: supp.sex === '男' ? '1' : '2',
    b5: (supp.postalCode || '').replace(/-/g, ''),
    b2: bundle.patientName,
    c3: admissionRouteToCode(nurseAdm.admissionRoute.value),
    c13: '0',  // 紹介の有無デフォルト無
    c14: '0',  // 自院外来からなしデフォルト
    c15: '100', // 予定通常入院（療養型デフォルト）
    c16: nurseAdm.ambulanceArrival ? '1' : '0',
    c42: String(nurseAdm.homeMedicalCareBeforeAdmission.value),
    d298: '0',
    d399: '0',
    c5: dischargeDestinationToCode(nurseDis.dischargeDestination.value),
    c7: String(dis.outcome.value),
    c8: '0',  // 24時間以内死亡なしデフォルト
    c43: String(nurseDis.homeMedicalCareAfterDischarge.value),
    a2: supp.departmentCode || '120',  // デフォルト整形外科
    a3: dis.departmentChange ? '1' : '0',
    c25: supp.wardKind === 'ryoyo' ? '0' : '1',  // 一般病棟
    c26: '0',                                     // 精神病棟（マオカに該当病棟なし）
    c27: supp.wardKind === 'ryoyo' ? '1' : '0',  // その他病棟＝療養病棟
    f39: String(adm.admissionPurpose.value),
    f4: '0',  // 治験なし
    c10: supp.previousDischargeDate
      ? toYYYYMMDD(supp.previousDischargeDate)
      : '99999999',
    c11: '99999999',  // 前回同一傷病自院入院（不明）
    c35: '',  // 再入院種別（該当時のみ）
    c36: '',
    c37: '',
    d162: nurseAdm.heightCm != null ? String(nurseAdm.heightCm) : '',
    d163: nurseAdm.weightKg != null ? formatWeight(nurseAdm.weightKg) : '',
    d164: nurseDis.weightAtDischarge != null ? formatWeight(nurseDis.weightAtDischarge) : '',
    d197: dementiaToCode(nurseAdm.dementiaLevel.value),
    d334: '9',  // 要介護度（不明デフォルト）
    d414: '000000',  // GLIM低栄養（未判定）
    d415: String(adm.swallowingImpairment.value),
    d416: '000000',
    d417: String(dis.swallowingImpairmentAtDischarge.value),
    d418: adm.nutritionRoute5.value,
    d419: dis.nutritionRoute5AtDischarge.value,
    d100: adlAdm,
    d119: adlDis,
    f13: adm.jcsAtAdmission.value || '0',
    f128: dis.jcsAtDischarge.value || '0',

    // 病名
    d2: mainD?.icd10 || '',
    d4: '0000999',  // 傷病名マスタコード（カスタム病名）
    d1: mainD?.name || '',
    d9: triggerD?.icd10 || '',
    d11: '0000999',
    d8: triggerD?.name || '',
    d16: resourceD?.icd10 || '',
    d18: '0000999',
    d15: resourceD?.name || '',

    // 入院時併存症 1〜10
    d30: comorbid[0]?.icd10 || '', d32: comorbid[0] ? '0000999' : '', d29: comorbid[0]?.name || '',
    d37: comorbid[1]?.icd10 || '', d39: comorbid[1] ? '0000999' : '', d36: comorbid[1]?.name || '',
    d44: comorbid[2]?.icd10 || '', d46: comorbid[2] ? '0000999' : '', d43: comorbid[2]?.name || '',
    d51: comorbid[3]?.icd10 || '', d53: comorbid[3] ? '0000999' : '', d50: comorbid[3]?.name || '',
    d199: comorbid[4]?.icd10 || '', d200: comorbid[4] ? '0000999' : '', d198: comorbid[4]?.name || '',
    d207: comorbid[5]?.icd10 || '', d208: comorbid[5] ? '0000999' : '', d206: comorbid[5]?.name || '',
    d215: comorbid[6]?.icd10 || '', d216: comorbid[6] ? '0000999' : '', d214: comorbid[6]?.name || '',
    d223: comorbid[7]?.icd10 || '', d224: comorbid[7] ? '0000999' : '', d222: comorbid[7]?.name || '',
    d231: comorbid[8]?.icd10 || '', d232: comorbid[8] ? '0000999' : '', d230: comorbid[8]?.name || '',
    d239: comorbid[9]?.icd10 || '', d240: comorbid[9] ? '0000999' : '', d238: comorbid[9]?.name || '',

    // 入院後発症 1〜10
    d58: post[0]?.icd10 || '', d60: post[0] ? '0000999' : '', d57: post[0]?.name || '',
    d65: post[1]?.icd10 || '', d67: post[1] ? '0000999' : '', d64: post[1]?.name || '',
    d72: post[2]?.icd10 || '', d74: post[2] ? '0000999' : '', d71: post[2]?.name || '',
    d79: post[3]?.icd10 || '', d81: post[3] ? '0000999' : '', d78: post[3]?.name || '',
    d247: post[4]?.icd10 || '', d248: post[4] ? '0000999' : '', d246: post[4]?.name || '',
    d255: post[5]?.icd10 || '', d256: post[5] ? '0000999' : '', d254: post[5]?.name || '',
    d263: post[6]?.icd10 || '', d264: post[6] ? '0000999' : '', d262: post[6]?.name || '',
    d271: post[7]?.icd10 || '', d272: post[7] ? '0000999' : '', d270: post[7]?.name || '',
    d279: post[8]?.icd10 || '', d280: post[8] ? '0000999' : '', d278: post[8]?.name || '',
    d287: post[9]?.icd10 || '', d288: post[9] ? '0000999' : '', d286: post[9]?.name || '',

    a9: supp.wardCode || '',
    d477: '',  // 入院前の生活の場への復帰（不明）
  };

  return row;
}

// ============================================================
// 複数患者を1つのFL00001ファイルに書き出す
// ============================================================
export function emitFL00001(rows: FL00001Row[]): Buffer {
  const lines: string[] = [];
  // ヘッダ行
  lines.push(COLUMNS.join('\t'));
  // データ行
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => row[c] ?? '').join('\t'));
  }
  const text = lines.join('\r\n') + '\r\n';
  return iconv.encode(text, 'SHIFT_JIS');
}
