// DPC連絡表生成のためのカルテデータ取得層
// 既存 collect.ts は退院サマリー用に最小化されているため、連絡表に必要な
// 追加データ（病名フル/栄養オーダー/酸素データ/リハ/褥瘡/検査所見/添付ファイル/身長体重）
// を取得する関数をここに集約する。
//
// 元実装: ~/Projects/Henry/extension/scripts/karte/timeline/data-fetch.ts
//
// GraphQLの query() は既存 graphql.ts のものを共用。
import { query } from './graphql.ts';
import { webappsFirestoreFetch } from './webapps-auth.ts';
import { loadDiseaseMaster, codeToIcd10, type DiseaseMaster } from './disease-master.ts';
import type { HenryDate, HenryDisease, HenryClinicalDocument } from './types.ts';
import type {
  BodyMeasurement, NutritionOrder, InjectionOrder, CQDModuleCollection,
  PressureUlcerRecord, RehabRecord, InspectionFinding, PatientFile, DiagnosisItem,
} from './renraku-types.ts';

// ============================================================
// カスタム文書タイプUUID（Henry本体の constants と同期）
// ============================================================
export const CDT_UUID = {
  NURSING_RECORD:      'e4ac1e1c-40e2-4c19-9df4-aa57adae7d4f',
  PATIENT_PROFILE:     'f639619a-6fdb-452a-a803-8d42cd50830d',
  PRESSURE_ULCER:      '2d3b6bbf-3b3e-4a82-8f7f-e29a32352f52',
  PHARMACY_RECORD:     '2de23e84-0e84-4861-8763-77c8d45f94bb',
  INSPECTION_FINDINGS: 'f83d4392-7a68-4c6c-9eef-8947097fb29d',
  ADMISSION_ORDER:     'b9d02078-751e-4ec8-a17a-f31892997e88',
  ADMISSION_INSTRUCTION: 'c4e74c15-b9d3-4b35-974d-6fe4307d8f43',
} as const;

// ============================================================
// 病名フル取得（ICD-10コード・登録日・副病名・疑い全部）
// 既存 fetchMainDisease を置き換える拡張版
// ============================================================
const Q_LIST_DISEASES = `
  query ListPatientReceiptDiseases($input: ListPatientReceiptDiseasesRequestInput!) {
    listPatientReceiptDiseases(input: $input) {
      patientReceiptDiseases {
        uuid
        patientUuid
        startDate { year month day }
        endDate { year month day }
        outcome
        isMain
        isSuspected
        excludeReceipt
        patientCareType
        masterDisease { name code }
        masterModifiers { name code position }
        customDiseaseName { value }
        isDraft
      }
    }
  }`;

export async function fetchAllDiseases(patientUuid: string): Promise<DiagnosisItem[]> {
  const [data, master] = await Promise.all([
    query<{
      listPatientReceiptDiseases?: { patientReceiptDiseases?: HenryDisease[] };
    }>(Q_LIST_DISEASES, {
      input: {
        patientUuids: [patientUuid],
        patientCareType: 'PATIENT_CARE_TYPE_INPATIENT',
        onlyMain: false,
      },
    }),
    loadDiseaseMaster(),
  ]);

  const diseases = data.listPatientReceiptDiseases?.patientReceiptDiseases || [];
  return diseases
    .filter((d) => d.patientUuid === patientUuid && !d.isDraft)
    .map((d) => toDiagnosisItem(d, master));
}

function toDiagnosisItem(d: HenryDisease, master: DiseaseMaster): DiagnosisItem {
  const baseName = d.masterDisease?.name || d.customDiseaseName?.value || '';
  const prefixes = (d.masterModifiers || [])
    .filter((m) => m.position === 'PREFIX')
    .map((m) => m.name)
    .join('');
  const suffixes = (d.masterModifiers || [])
    .filter((m) => m.position === 'SUFFIX')
    .map((m) => m.name)
    .join('');
  // masterDisease.code は保険病名コード（7桁）。ICD-10は病名マスタから引く
  const insuranceCode = d.masterDisease?.code || '';
  const icd10 = codeToIcd10(master, insuranceCode);
  return {
    uuid: d.uuid,
    name: prefixes + baseName + suffixes,
    icd10,
    startDate: fmtDate(d.startDate),
    endDate: fmtDate(d.endDate),
    isMain: d.isMain,
    isSuspected: !!d.isSuspected,
    outcome: d.outcome || '',
  };
}

function fmtDate(d: HenryDate | null | undefined): string {
  if (!d || !d.year) return '';
  return `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}`;
}

// ============================================================
// 身長・体重取得（PatientBodyMeasurements / graphql-v2）
//
// 元実装: henry_ikensho_form.ts の fetchBodyMeasurements() および
//        henry_data.ts の getLatestBodyMeasurement() に倣う。
// 直近1年間に絞って取得し、見つからない場合は空配列を返す（測定なし）。
// ============================================================
const Q_BODY_MEASUREMENTS = `
  query PatientBodyMeasurements($patientId: ID!, $startDate: IsoDate!, $endDate: IsoDate!, $pageSize: Int!, $pageToken: String!) {
    patientBodyMeasurements(patientId: $patientId, startDate: $startDate, endDate: $endDate, pageSize: $pageSize, pageToken: $pageToken) {
      results {
        id
        weightGram
        heightCm
        measuredAt
      }
      nextPageToken
    }
  }`;

/**
 * 身長・体重を取得（古い順）。
 * 期間は入院期間 ± 余裕を確保。入院前測定にも遡れるよう過去1年まで遡る。
 */
export async function fetchBodyMeasurements(
  patientUuid: string,
  hospStartIso: string,
  hospEndIso: string,
): Promise<BodyMeasurement[]> {
  // 入院日の1年前から退院日まで（入院前の最後の測定値が必要なケース対応）
  const startDate = (() => {
    const d = new Date(hospStartIso);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const data = await query<{
    patientBodyMeasurements?: { results: BodyMeasurement[]; nextPageToken: string };
  }>(
    Q_BODY_MEASUREMENTS,
    { patientId: patientUuid, startDate, endDate: hospEndIso, pageSize: 50, pageToken: '' },
    '/graphql-v2',
  );
  const results = data.patientBodyMeasurements?.results || [];
  // measuredAt 昇順にソート（呼び出し側で「直近」を取りやすくする）
  return results.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}

// ============================================================
// 共有情報（タイムラインV2の「共有情報」枠・退院支援等の情報源）
//
// 保存先: maokahp-webapps Firestore の `wardPatients/{patientUuid}.notes`
// 内容: Markdown テキスト。多職種が共有・編集する自由記述
// 編集履歴: `wardPatients/{patientUuid}/notesHistory/{revisionId}`
//
// 連絡表用途:
// - 退院先・退院後の在宅医療
// - 認知症自立度・寝たきり度の参考
// - 入院前の生活背景
// ============================================================
export interface SharedInfo {
  notes: string;
  notesUpdatedAt: string | null; // ISO
}

/** wardPatients/{patientId}.notes をmaokahp-webapps Firestoreから取得 */
export async function fetchSharedInfo(patientUuid: string): Promise<SharedInfo> {
  try {
    const res = await webappsFirestoreFetch(`wardPatients/${patientUuid}`, { method: 'GET' });
    if (!res.ok || !res.body) {
      // ドキュメント未作成（=共有情報が一度も書かれていない患者）の場合は 404
      return { notes: '', notesUpdatedAt: null };
    }
    const parsed = JSON.parse(res.body) as {
      fields?: Record<string, {
        stringValue?: string;
        timestampValue?: string;
        mapValue?: { fields?: Record<string, { integerValue?: string; timestampValue?: string }> };
      }>;
    };
    const fields = parsed.fields || {};
    const notes = fields.notes?.stringValue || '';
    // notesUpdatedAt は { ms: int, ts: timestamp } のmap形式 or 単独timestampValueのどちらかありうる
    const updatedTs = fields.notesUpdatedAt?.timestampValue
      ?? fields.notesUpdatedAt?.mapValue?.fields?.ts?.timestampValue
      ?? null;
    return { notes, notesUpdatedAt: updatedTs };
  } catch (e) {
    console.error('[fetchSharedInfo] 取得失敗', e instanceof Error ? e.message : e);
    return { notes: '', notesUpdatedAt: null };
  }
}

// ============================================================
// カレンダーデータ（連絡表用フル版）
// 既存 fetchCalendarData では nutritionOrders / clinicalQuantitativeDataModuleCollections を
// 取得していないため、連絡表専用のフルクエリ版をここに用意する。
// ============================================================
const CALENDAR_RESOURCES_FULL = [
  '//henry-app.jp/clinicalResource/vitalSign',
  '//henry-app.jp/clinicalResource/prescriptionOrder',
  '//henry-app.jp/clinicalResource/injectionOrder',
  '//henry-app.jp/clinicalResource/nutritionOrder',
  // 院内検査・食事摂取量・尿量・血糖・酸素データのカスタム定量データ定義
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/614e72ad-78ed-4aba-98a9-25d87efcf846', // 院内検査
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/f20a5f9d-e40d-4049-a24b-a5e5809dc7e8',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/749ade09-5c03-4c6d-a8c4-cf4c386f8f1a',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/1588e236-8eee-4f54-9114-e11c57108f8c',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/77be0d2e-181d-42e1-940b-b27863594c6b',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/772cbf1e-a6e6-42aa-bb88-2b1d650a658a',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/fb5d9b7b-8857-40b6-a82b-2547a6ae9e56',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/e54f72b3-ee52-45e9-9dfb-fda4615f9722',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/2b5d1d50-d162-46b5-a3b9-34608ea8e805',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/38c01268-1ffb-4a2f-a227-85f0fafe4780',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/d4c6e8b3-81ee-431f-adbe-dc113294a356',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/883dbf3c-8774-447b-b519-3141fa1ab9a4',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/8142e84b-dadf-465e-b1f6-6b691bbd6588',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/7d50a032-4049-429c-8c58-1a7c8c353390',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/3249f5de-f0c3-496a-968e-7b4d014a5cba',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/a849cd3d-7840-462f-9a62-26d1dcf3bec1',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/f2297762-d0ef-4b88-ae76-61f12569e565',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/9c812b76-e0f5-4a98-af02-aef5885a851c',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/e7a84f72-cece-4d39-9d4e-efa029829423',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/ec34fca6-d32b-4519-b167-266e6e6cf006',
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/125c88b0-1151-4ce0-b31b-ddbe3abadef8',
  '//henry-app.jp/clinicalResource/inspectionReport',
  '//henry-app.jp/clinicalResource/specimenInspectionOrder',
];

export interface FullCalendarData {
  vitalSigns: Array<{
    recordTime?: { seconds: number };
    temperature?: { value: number } | null;
    pulseRate?: { value: number } | null;
    bloodPressureUpperBound?: { value: number } | null;
    bloodPressureLowerBound?: { value: number } | null;
    spo2?: { value: number } | null;
    respiration?: { value: number } | null;
  }>;
  prescriptionOrders: Array<Record<string, unknown>>;
  injectionOrders: InjectionOrder[];
  nutritionOrders: NutritionOrder[];
  clinicalQuantitativeDataModuleCollections: CQDModuleCollection[];
  outsideInspectionReportGroups: Array<Record<string, unknown>>;
}

/** 入院期間全体のカレンダーデータを取得（連絡表用） */
export async function fetchFullCalendar(
  patientUuid: string,
  hospStartDate: Date,
  hospEndDate: Date,
): Promise<FullCalendarData> {
  if (!/^[0-9a-f-]{36}$/.test(patientUuid)) throw new Error('Invalid patient UUID');
  const days = Math.ceil((hospEndDate.getTime() - hospStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const baseDate = hospEndDate;
  const resourcesStr = CALENDAR_RESOURCES_FULL.map((r) => `"${r}"`).join(', ');

  const graphql = `
    query GetClinicalCalendarView {
      getClinicalCalendarView(input: {
        patientUuid: "${patientUuid}",
        baseDate: { year: ${baseDate.getFullYear()}, month: ${baseDate.getMonth() + 1}, day: ${baseDate.getDate()} },
        beforeDateSize: ${days},
        afterDateSize: 0,
        clinicalResourceHrns: [${resourcesStr}],
        createUserUuids: [],
        accountingOrderShinryoShikibetsus: []
      }) {
        vitalSigns {
          recordTime { seconds }
          temperature { value }
          pulseRate { value }
          bloodPressureUpperBound { value }
          bloodPressureLowerBound { value }
          spo2 { value }
          respiration { value }
        }
        prescriptionOrders {
          uuid
          createTime { seconds }
          startDate { year month day }
          orderStatus
          medicationCategory
        }
        injectionOrders {
          uuid
          createTime { seconds }
          startDate { year month day }
          orderStatus
          medicationCategory
          rps {
            boundsDurationDays { value }
            dosageText
            localInjectionTechnique { name }
            instructions {
              instruction {
                medicationDosageInstruction {
                  localMedicine { name }
                  mhlwMedicine { name }
                }
              }
            }
          }
        }
        nutritionOrders {
          uuid
          orderStatus
          isDraft
          startDate { year month day }
          endDate { year month day }
          detail {
            dietaryRegimen { name }
            supplies {
              food { name }
              timing
              quantity { value }
            }
          }
        }
        clinicalQuantitativeDataModuleCollections {
          cqdDefHrn
          clinicalQuantitativeDataModules {
            title
            recordDateRange { start { year month day } }
            entries {
              name
              value
              unit { value }
            }
          }
        }
        outsideInspectionReportGroups {
          name
          outsideInspectionReportRows {
            name
            standardValue { value }
            outsideInspectionReports {
              date { year month day }
              value
              isAbnormal
              abnormalityType
            }
          }
        }
      }
    }`;

  const data = await query<{ getClinicalCalendarView?: Partial<FullCalendarData> }>(graphql, {}, '/graphql');
  const cal = data.getClinicalCalendarView;
  return {
    vitalSigns: cal?.vitalSigns || [],
    prescriptionOrders: cal?.prescriptionOrders || [],
    injectionOrders: cal?.injectionOrders || [],
    nutritionOrders: cal?.nutritionOrders || [],
    clinicalQuantitativeDataModuleCollections: cal?.clinicalQuantitativeDataModuleCollections || [],
    outsideInspectionReportGroups: cal?.outsideInspectionReportGroups || [],
  };
}

// ============================================================
// リハビリ記録（ADL/嚥下評価の主要情報源）
// ============================================================
const Q_REHAB = `
  query ListRehabilitationDocuments($input: ListRehabilitationDocumentsRequestInput!) {
    listRehabilitationDocuments(input: $input) {
      documents {
        uuid
        editorData
        performTime { seconds }
        endTime { seconds }
        createUser { name }
        createUserUuid
        rehabilitationOrderUuid { value }
      }
      nextPageToken
    }
  }`;

export async function fetchRehabRecords(patientUuid: string): Promise<RehabRecord[]> {
  const today = new Date();
  const all: RehabRecord[] = [];
  let pageToken = '';
  // 安全のため最大10ページに制限（500件相当）
  for (let i = 0; i < 10; i++) {
    const data = await query<{
      listRehabilitationDocuments?: {
        documents: Array<{
          uuid: string;
          editorData: string;
          performTime?: { seconds: number };
          createUser?: { name: string };
          rehabilitationOrderUuid?: { value: string };
        }>;
        nextPageToken: string;
      };
    }>(Q_REHAB, {
      input: {
        patientUuid,
        date: { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() },
        pageSize: 50,
        pageToken,
      },
    });
    const docs = data.listRehabilitationDocuments?.documents || [];
    for (const doc of docs) {
      const text = parseEditorData(doc.editorData, true);
      if (text) {
        all.push({
          uuid: doc.uuid,
          date: doc.performTime?.seconds ? new Date(doc.performTime.seconds * 1000) : null,
          text,
          author: doc.createUser?.name || '不明',
          rehabOrderUuid: doc.rehabilitationOrderUuid?.value || null,
        });
      }
    }
    pageToken = data.listRehabilitationDocuments?.nextPageToken || '';
    if (!pageToken) break;
  }
  return all;
}

// ============================================================
// 褥瘡評価記録
// ============================================================
export async function fetchPressureUlcerRecords(patientUuid: string): Promise<PressureUlcerRecord[]> {
  return fetchByCustomType(patientUuid, CDT_UUID.PRESSURE_ULCER, parsePressureUlcerToRecord);
}

// ============================================================
// 検査所見（読影レポート等）
// ============================================================
export async function fetchInspectionFindings(patientUuid: string): Promise<InspectionFinding[]> {
  return fetchByCustomType(patientUuid, CDT_UUID.INSPECTION_FINDINGS, (doc) => ({
    uuid: doc.uuid,
    date: doc.performTime?.seconds ? new Date(doc.performTime.seconds * 1000) : null,
    text: parseEditorData(doc.editorData, false),
    author: doc.creator?.name || '不明',
  }));
}

// ============================================================
// 患者添付ファイル一覧（紹介状PDF等）
// ============================================================
const Q_PATIENT_FILES = `
  query ListPatientFiles($patientId: ID!, $parentFolderId: ID, $searchQuery: String, $pageSize: Int!, $pageToken: String!) {
    listPatientFiles(patientId: $patientId, parentFolderId: $parentFolderId, searchQuery: $searchQuery, pageSize: $pageSize, pageToken: $pageToken) {
      patientFiles { id title fileType redirectUrl fileSize createTime }
      nextPageToken
    }
  }`;

export async function fetchPatientFiles(patientUuid: string): Promise<PatientFile[]> {
  const data = await query<{ listPatientFiles?: { patientFiles?: PatientFile[] } }>(
    Q_PATIENT_FILES,
    { patientId: patientUuid, parentFolderId: null, searchQuery: null, pageSize: 100, pageToken: '' },
    '/graphql-v2',
  );
  return data.listPatientFiles?.patientFiles || [];
}

// ============================================================
// 任意カスタム文書タイプの取得（汎用）
// ============================================================
const Q_LIST_CLINICAL_DOCS = `
  query ListClinicalDocuments($input: ListClinicalDocumentsRequestInput!) {
    listClinicalDocuments(input: $input) {
      documents {
        uuid
        editorData
        performTime { seconds }
        updateTime { seconds }
        creator { name }
        type {
          type
          clinicalDocumentCustomTypeUuid { value }
        }
      }
      nextPageToken
    }
  }`;

interface ListClinicalDocsResponse {
  listClinicalDocuments?: {
    documents: HenryClinicalDocument[];
    nextPageToken: string | null;
  };
}

async function fetchByCustomType<T>(
  patientUuid: string,
  customTypeUuid: string,
  mapper: (doc: HenryClinicalDocument) => T | null,
): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | null = '';
  while (pageToken !== null) {
    const resp: ListClinicalDocsResponse = await query<ListClinicalDocsResponse>(Q_LIST_CLINICAL_DOCS, {
      input: {
        patientUuid,
        clinicalDocumentTypes: [{ type: 'CUSTOM', clinicalDocumentCustomTypeUuid: { value: customTypeUuid } }],
        pageSize: 100,
        pageToken,
      },
    });
    const docs = resp.listClinicalDocuments?.documents || [];
    for (const d of docs) {
      const item = mapper(d);
      if (item) all.push(item);
    }
    pageToken = resp.listClinicalDocuments?.nextPageToken || null;
  }
  return all;
}

// ============================================================
// 組織メンバーシップ取得（医師→診療科の動的マッピング）
//
// マオカ病院の医師リストをHenryから取得し、医師名→診療科をマップ化。
// FF1出力時の診療科コード判定（整形外科=120、内科=010 等）に使う。
// ============================================================
const Q_LIST_ORG_MEMBERSHIPS = `
  query ListOrganizationMemberships($input: ListOrganizationMembershipsRequestInput!) {
    listOrganizationMemberships(input: $input) {
      organizationMemberships {
        userUuid
        role
        departmentName { value }
        user { uuid name namePhonetic { value } }
      }
      nextPageToken
    }
  }`;

export interface DoctorInfo {
  userUuid: string;
  name: string;          // 「満岡 弘巳」等（半角/全角スペース揺れあり）
  namePhonetic: string;  // 「マオカ ヒロミ」
  departmentName: string; // 「整形外科」「内科」等
}

let _orgMembersCache: DoctorInfo[] | null = null;

/** 組織の医師（DOCTORロール）一覧を取得 */
export async function fetchOrganizationDoctors(): Promise<DoctorInfo[]> {
  if (_orgMembersCache) return _orgMembersCache;
  const all: DoctorInfo[] = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const data = await query<{
      listOrganizationMemberships?: {
        organizationMemberships?: Array<{
          userUuid: string;
          role: string;
          departmentName?: { value?: string } | null;
          user?: { uuid: string; name: string; namePhonetic?: { value?: string } };
        }>;
        nextPageToken?: string;
      };
    }>(Q_LIST_ORG_MEMBERSHIPS, { input: { pageSize: 200, pageToken } });
    const members = data.listOrganizationMemberships?.organizationMemberships || [];
    for (const m of members) {
      if (m.role !== 'DOCTOR') continue;
      const deptName = m.departmentName?.value || '';
      if (!deptName) continue;
      all.push({
        userUuid: m.userUuid,
        name: m.user?.name || '',
        namePhonetic: m.user?.namePhonetic?.value || '',
        departmentName: deptName,
      });
    }
    pageToken = data.listOrganizationMemberships?.nextPageToken || '';
    if (!pageToken) break;
  }
  _orgMembersCache = all;
  console.log(`[org-doctors] 取得完了: ${all.length}名（DOCTORロール）`);
  return all;
}

/** 医師名→診療科名（部分一致・正規化対応） */
export function findDepartmentByDoctorName(
  doctors: DoctorInfo[],
  doctorName: string,
): string | null {
  if (!doctorName) return null;
  // スペース正規化（全角/半角・余分なスペース除去）
  const normalize = (s: string): string => s.replace(/[\s　]+/g, '').trim();
  const target = normalize(doctorName);
  const exact = doctors.find((d) => normalize(d.name) === target);
  if (exact) return exact.departmentName;
  // フォールバック：苗字のみ一致（例「長町」だけの記載でも判定できる）
  const surname = target.match(/^[^\s　]{1,3}/)?.[0] || '';
  if (surname.length >= 2) {
    const bySurname = doctors.filter((d) => normalize(d.name).startsWith(surname));
    if (bySurname.length === 1) return bySurname[0].departmentName;
  }
  return null;
}

/** 診療科名 → DPC提出用診療科コード（マオカで実出現するもののマッピング） */
export function departmentToDpcCode(departmentName: string): string {
  switch (departmentName) {
    case '内科': return '010';
    case '整形外科': return '120';
    case '精神科': return '020';
    case '放射線科': return '230';
    case '麻酔科': return '100';  // 実情に応じて要調整
    case '泌尿器科': return '130';
    default: return '120';  // 不明時は整形外科デフォルト（マオカ実績）
  }
}

// ============================================================
// 全カスタム文書タイプ一覧取得（マオカ独自タイプを発見するため）
// ============================================================
const Q_CDT_LIST = `
  query ListClinicalDocumentCustomTypes {
    listClinicalDocumentCustomTypes {
      clinicalDocumentCustomTypes {
        uuid
        name
        displayOrder { value }
      }
    }
  }`;

export async function fetchClinicalDocumentCustomTypes(): Promise<
  Array<{ uuid: string; name: string; displayOrder: number }>
> {
  const data = await query<{
    listClinicalDocumentCustomTypes?: {
      clinicalDocumentCustomTypes?: Array<{ uuid: string; name: string; displayOrder?: { value: number } }>;
    };
  }>(Q_CDT_LIST, {});
  const list = data.listClinicalDocumentCustomTypes?.clinicalDocumentCustomTypes || [];
  return list.map((t) => ({ uuid: t.uuid, name: t.name, displayOrder: t.displayOrder?.value ?? 999 }));
}

// ============================================================
// パース系（editorData → 文字列）
// ============================================================
function parseEditorData(editorDataStr: string, filterUnchecked = false): string {
  try {
    const data = JSON.parse(editorDataStr);
    const lines: string[] = [];
    for (const block of data.blocks || []) {
      const text = block.text;
      if (!text || !text.trim()) continue;
      if (filterUnchecked && block.data?.checkboxListItem?.checked === 'unchecked') continue;
      lines.push(text);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// DESIGN-R パターン（褥瘡評価）
const DESIGN_R_PATTERNS = {
  D: /^([dD]\d+|[dD][DU]TI?|[dD]U)/i,
  E: /^([eE]\d+)/,
  S: /^([sS]\d+)/,
  I: /^([iI]\d+[CcGg]?)/,
  G: /^([gG]\d+)/,
  N: /^([nN]\d+)/,
  P: /^([pP]\d+)/,
} as const;

function parsePressureUlcerToRecord(doc: HenryClinicalDocument): PressureUlcerRecord | null {
  try {
    const data = JSON.parse(doc.editorData);
    const blocks = data.blocks || [];
    let site = '';
    let totalScore = '';
    const designR: Record<'D' | 'E' | 'S' | 'I' | 'G' | 'N' | 'P', string | null> = {
      D: null, E: null, S: null, I: null, G: null, N: null, P: null,
    };

    for (const block of blocks) {
      const text = (block.text || '').trim();
      const isChecked = block.data?.checkboxListItem?.checked === 'checked';

      const totalMatch = text.match(/合計点\s*[:：]\s*[０-９\d]+点?\s*部位\s*[:：]\s*(.+)/);
      if (totalMatch) {
        const scoreMatch = text.match(/合計点\s*[:：]\s*([０-９\d]+)/);
        if (scoreMatch) {
          totalScore = scoreMatch[1].replace(/[０-９]/g, (s: string) =>
            String.fromCharCode(s.charCodeAt(0) - 0xfee0),
          );
        }
        site = totalMatch[1].trim();
        continue;
      }
      const siteOnlyMatch = text.match(/^部位\s*[:：]\s*(.+)/);
      if (siteOnlyMatch && !site) {
        site = siteOnlyMatch[1].trim();
        continue;
      }
      if (isChecked) {
        for (const [key, pattern] of Object.entries(DESIGN_R_PATTERNS) as Array<
          ['D' | 'E' | 'S' | 'I' | 'G' | 'N' | 'P', RegExp]
        >) {
          const match = text.match(pattern);
          if (match) {
            designR[key] = match[1];
            break;
          }
        }
      }
    }

    // 合計点が未記入なら算出（DはBarthelに含めない）
    if (!totalScore) {
      const scoreItems = ['E', 'S', 'I', 'G', 'N', 'P'] as const;
      let sum = 0;
      let hasAny = false;
      for (const k of scoreItems) {
        const v = designR[k];
        if (v) {
          const numMatch = v.match(/\d+/);
          if (numMatch) {
            sum += parseInt(numMatch[0], 10);
            hasAny = true;
          }
        }
      }
      if (hasAny) totalScore = String(sum);
    }

    const hasData = site || totalScore || Object.values(designR).some((v) => v !== null);
    if (!hasData) return null;

    return {
      uuid: doc.uuid,
      date: doc.performTime?.seconds ? new Date(doc.performTime.seconds * 1000) : null,
      author: doc.creator?.name || '不明',
      site,
      totalScore,
      designR,
    };
  } catch {
    return null;
  }
}
