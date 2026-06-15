// DPC連絡表（医師連絡表Ⅰ/Ⅱ・看護師連絡表）の型定義
// マッピング: ~/Projects/Henry/_private/dpc-renraku-mapping.md
//
// 様式1の項目コードは A000010 (ヘッダ系) / A006020 (病名) / JCS0010 / A004030 (栄養) /
// ADL0010/ADL0020 (ADL) などで識別。各フィールドに対応する様式1コードをJSDocで明記する。

import type { HenryDate } from './types.ts';

// ============================================================
// データソース拡張用の型（Henry GraphQLレスポンス受け側）
// ============================================================

/** PatientBodyMeasurements の1件 */
export interface BodyMeasurement {
  id: string;
  weightGram: number | null;
  heightCm: number | null;
  measuredAt: string; // ISO date
}

/** 栄養オーダー（calendar 内、nutritionOrders から取得） */
export interface NutritionOrder {
  uuid: string;
  orderStatus: string;
  isDraft?: boolean;
  startDate: HenryDate | null;
  endDate: HenryDate | null;
  detail?: {
    dietaryRegimen?: { name: string } | null;
    supplies?: Array<{
      food?: { name: string };
      timing?: string;
      quantity?: { value: number };
    }>;
  };
}

/** 注射オーダー（calendar 内、injectionOrders から取得） */
export interface InjectionOrder {
  uuid: string;
  createTime?: { seconds: number };
  startDate?: HenryDate;
  orderStatus: string;
  medicationCategory?: string;
  rps?: Array<{
    boundsDurationDays?: { value: number } | null;
    dosageText?: string;
    localInjectionTechnique?: { name: string } | null;
    instructions?: Array<{
      instruction?: {
        medicationDosageInstruction?: {
          localMedicine?: { name: string } | null;
          mhlwMedicine?: { name: string } | null;
        };
      };
    }>;
  }>;
}

/** 定量データモジュール（食事摂取量/尿量/血糖/酸素/院内検査が入る） */
export interface CQDModuleCollection {
  cqdDefHrn: string;
  clinicalQuantitativeDataModules: Array<{
    title?: string;
    recordDateRange?: { start: HenryDate } | null;
    entries: Array<{
      name: string;
      value: string | null;
      unit?: { value: string } | null;
    }>;
  }>;
}

/** 褥瘡評価レコード */
export interface PressureUlcerRecord {
  uuid: string;
  date: Date | null;
  author: string;
  site: string;
  totalScore: string;
  designR: Record<'D' | 'E' | 'S' | 'I' | 'G' | 'N' | 'P', string | null>;
}

/** リハビリ記録 */
export interface RehabRecord {
  uuid: string;
  date: Date | null;
  text: string;
  author: string;
  rehabOrderUuid?: string | null;
}

/** 検査所見（読影レポート等） */
export interface InspectionFinding {
  uuid: string;
  date: Date | null;
  text: string;
  author: string;
}

/** 患者添付ファイル */
export interface PatientFile {
  id: string;
  title: string;
  fileType: string;
  redirectUrl: string;
  fileSize: number;
  createTime: string;
}

/** 酸素データの1エントリ（時刻ソート用） */
export interface OxygenEntry {
  time: number; // 分単位（00:00からの差）
  flow: string | null;
  method: string | null;
}

// ============================================================
// 連絡表の出力用型
// ============================================================

/** ICDコード付きの病名（連絡表の病名欄共通） */
export interface DiagnosisItem {
  uuid: string;
  name: string;
  icd10: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  isMain: boolean;
  isSuspected: boolean;
  outcome: string;
}

/** LLMの根拠引用（医師確認用） */
export interface Evidence {
  location: string; // 例: "2026-05-29 医師記録"
  text: string;     // 引用された原文
}

/** LLM出力の自信度 */
export type Confidence = 'high' | 'medium' | 'low';

/** ある項目1つ分のLLM出力（候補値+根拠+自信度） */
export interface Decision<T> {
  value: T;
  confidence: Confidence;
  evidence: Evidence[];
  needsMdReview?: boolean;
  alternatives?: Array<{ value: T; reason: string }>;
}

// ============================================================
// 医師連絡表Ⅰ（入院時）
// ============================================================
export interface DoctorFormI_Admission {
  /** A000060 ② 入院中の主な診療目的 (1=診断検査 / 2=教育 / 3=計画的繰返し / 4=その他加療) */
  admissionPurpose: Decision<1 | 2 | 3 | 4>;

  /** A006020 ⑨ 入院の契機となった傷病名 */
  triggerDisease: Decision<DiagnosisItem>;

  /** JCS0010 ② 入院時意識障害がある場合のJCS (0=なし / 1〜300, R/I/A補助記号付与可) */
  jcsAtAdmission: Decision<string>; // 例: "0", "3", "3RA", "10R"

  /** A004030 ④ 摂食・嚥下機能障害の有無 (0=なし / 1=あり / 9=未判定) */
  swallowingImpairment: Decision<0 | 1 | 9>;

  /** A004030 ⑦ 経管・経静脈栄養の状況 (5桁ビット列、例: "10100") */
  nutritionRoute5: Decision<string>;

  /** Ⅱ送りが必要なら病名リスト（肝硬変・熱傷・敗血症など） */
  requiresFormII: string[];
}

/** 医師連絡表Ⅰ（入院時後半・併存病名/再入院） */
export interface DoctorFormI_AdmissionExtras {
  /** A006040 入院時併存病名 */
  comorbidities: DiagnosisItem[];

  /** A006050 入院後発症病名 */
  postAdmissionDiseases: DiagnosisItem[];

  /** A000080 再入院（4週以内）に該当する場合の理由 */
  readmissionReason: Decision<{
    category: 'planned' | 'unplanned' | null;
    code: number; // 1〜7
    label: string;
  }> | null;
}

// ============================================================
// 医師連絡表Ⅰ（退院時）
// ============================================================
export interface DoctorFormI_Discharge {
  /** A000030 ② 退院時転帰 (1=治癒・軽快 / 2=寛解 / 3=不変 / 4=増悪 / 5=他病死亡 / 6=その他) */
  outcome: Decision<1 | 2 | 3 | 4 | 5 | 6>;

  /** A000031 ② 転科の有無 */
  departmentChange: boolean;

  /** JCS0020 ② 退院時JCS */
  jcsAtDischarge: Decision<string>;

  /** A004030 ⑥ 退院時の摂食嚥下障害 */
  swallowingImpairmentAtDischarge: Decision<0 | 1 | 9>;

  /** A004030 ⑧ 退院時の経管・経静脈栄養5桁 */
  nutritionRoute5AtDischarge: Decision<string>;

  /** A006030 ⑨ 医療資源を最も投入した傷病名 */
  resourceDisease: Decision<DiagnosisItem>;

  /** A006010 ⑨ 主傷病名 */
  mainDisease: DiagnosisItem;
}

// ============================================================
// 医師連絡表Ⅱ（重症度系・該当病名のみ）
// ============================================================
export interface DoctorFormII {
  pneumonia?: PneumoniaSeverity;
  respiratoryFailure?: RespiratoryFailureSeverity;
  heartFailure?: HeartFailureSeverity;
  angina?: AnginaSeverity;
  // 脳卒中・急性膵炎・肝硬変はマオカで稀のため省略
}

export interface PneumoniaSeverity {
  /** M040020 医療・介護関連肺炎の重症度因子 */
  bunHighOrDehydration: Decision<0 | 1>;
  spO2Category: Decision<0 | 1 | 2>;
  consciousnessImpaired: 0 | 1;
  sbpLowerOrEqual90: 0 | 1;
  immunoCompromised: 0 | 1;
  severityFactor: Decision<0 | 1>;
  origin: Decision<3 | 5 | 8>; // 院内/市中/肺炎以外
  isMedicalCareRelated: Decision<0 | 1>;
  /** M040010 Hugh-Jones分類 */
  hughJones: Decision<'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | 'Ⅴ' | '0'>;
}

export interface RespiratoryFailureSeverity {
  /** M040031 P/F比・FiO2・酸素投与・呼吸補助 */
  pfRatio: Decision<number>;
  fio2: Decision<number>;
  oxygenSupply: Decision<0 | 1 | 9>;
  respiratorySupport: Decision<0 | 1 | 9>;
}

export interface HeartFailureSeverity {
  /** M050011 NYHA心機能分類 */
  nyha: Decision<'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | '0'>;
  /** M050041 入室時収縮期血圧 */
  sbpCategory: Decision<1 | 2 | 3>;
  /** 循環作動薬の使用 */
  vasoactiveDrug: Decision<0 | 1 | 9>;
  /** M050090 BNP/NT-proBNP */
  bnpCategory: Decision<1 | 2 | 3 | 9>;
}

export interface AnginaSeverity {
  /** M050020 CCS分類 */
  ccs: Decision<'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | '0' | '9'>;
}

// ============================================================
// 看護師用連絡表（入院/退院時）
// ============================================================
export interface NurseFormAdmission {
  /** A004030 嚥下障害 */
  swallowingImpairment: Decision<0 | 1 | 9>;
  /** 入院前の在宅医療 (0=なし / 1=当院提供 / 2=他施設提供 / 9=不明) */
  homeMedicalCareBeforeAdmission: Decision<0 | 1 | 2 | 9>;
  /** A001040 褥瘡の有無 */
  hasPressureUlcer: boolean;
  /** A001010 身長・体重・BMI */
  heightCm: number | null;
  weightKg: number | null;
  bmi: number | null;
  /** A000020 入院経路 */
  admissionRoute: Decision<string>;
  /** A004010 ② 認知症高齢者の日常生活自立度 */
  dementiaLevel: Decision<'自立' | 'Ⅰ' | 'Ⅱa' | 'Ⅱb' | 'Ⅲa' | 'Ⅲb' | 'Ⅳ' | 'M'>;
  /** A004010 ① 障害高齢者の日常生活自立度（寝たきり度） */
  bedriddenLevel: Decision<'J1' | 'J2' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'>;
  /** A000020 救急車搬送 */
  ambulanceArrival: boolean;
  /** ADL0010 入院時ADLスコア（10桁） */
  adlScoreAtAdmission: Decision<AdlScore>;
}

export interface NurseFormDischarge {
  /** A001010 ④ 退院時体重 */
  weightAtDischarge: number | null;
  /** A000030 関連 退院後の在宅医療 */
  homeMedicalCareAfterDischarge: Decision<0 | 1 | 2 | 9>;
  /** A000030 ② 退院先 */
  dischargeDestination: Decision<string>; // 0〜a の値
  /** ADL0020 退院時ADLスコア（10桁） */
  adlScoreAtDischarge: Decision<AdlScore>;
}

/** ADLスコアの10桁構造 */
export interface AdlScore {
  /** "1211111100" のような10桁文字列 */
  raw: string;
  meal: 0 | 1 | 2 | 9;            // 1桁目
  transfer: 0 | 1 | 2 | 3 | 9;    // 2桁目
  grooming: 0 | 1 | 9;            // 3桁目
  toilet: 0 | 1 | 2 | 9;          // 4桁目
  bath: 0 | 1 | 9;                // 5桁目
  walking: 0 | 1 | 2 | 3 | 9;     // 6桁目
  stairs: 0 | 1 | 2 | 9;          // 7桁目
  dressing: 0 | 1 | 2 | 9;        // 8桁目
  bowel: 0 | 1 | 2 | 9;           // 9桁目
  urine: 0 | 1 | 2 | 9;           // 10桁目
}

// ============================================================
// 連絡表バンドル（1患者の退院イベントに対する全フォーム出力）
// ============================================================
export interface RenrakuFormBundle {
  patientUuid: string;
  patientName: string;
  hospitalizationUuid: string;
  admissionDate: string;
  dischargeDate: string;
  generatedAt: string; // ISO timestamp

  doctorFormI_admission: DoctorFormI_Admission;
  doctorFormI_admissionExtras: DoctorFormI_AdmissionExtras;
  doctorFormI_discharge: DoctorFormI_Discharge;
  doctorFormII?: DoctorFormII;
  nurseFormAdmission: NurseFormAdmission;
  nurseFormDischarge: NurseFormDischarge;
}
