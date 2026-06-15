// Phase A: カルテデータ収集（henry_discharge_summary.ts のデータ収集部を Node へ移植）
// HenryCore.data.* の内部 GraphQL クエリ（DATA_QUERIES）を直接叩く。すべて /graphql。
import { query } from './graphql.ts';
import type {
  HenryDate,
  HenryPatient,
  HenryHospitalization,
  HenryDisease,
  HenryClinicalDocument,
} from './types.ts';

// CUSTOMタイプUUID（henry_discharge_summary.ts L43-44）
const NURSING_RECORD_CUSTOM_TYPE_UUID = 'e4ac1e1c-40e2-4c19-9df4-aa57adae7d4f';
const PATIENT_PROFILE_CUSTOM_TYPE_UUID = 'f639619a-6fdb-452a-a803-8d42cd50830d';

// カレンダービューリソース（henry_discharge_summary.ts L47-75 と同一・逐語）
const CALENDAR_RESOURCES = [
  '//henry-app.jp/clinicalResource/vitalSign',
  '//henry-app.jp/clinicalResource/prescriptionOrder',
  '//henry-app.jp/clinicalResource/injectionOrder',
  '//henry-app.jp/clinicalResource/nutritionOrder',
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
  '//henry-app.jp/clinicalResource/clinicalQuantitativeDataDefCustom/614e72ad-78ed-4aba-98a9-25d87efcf846',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ====================
// ユーティリティ（henry_discharge_summary.ts より移植）
// ====================

export function formatHenryDate(d: HenryDate | null): string {
  if (!d || !d.year) return '';
  return `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}`;
}

export function calculateAge(birthDate: HenryDate | null): number | null {
  if (!birthDate?.year) return null;
  const today = new Date();
  const birth = new Date(birthDate.year, (birthDate.month || 1) - 1, birthDate.day || 1);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export function genderText(sexType: string): string {
  if (!sexType) return '';
  return sexType.includes('FEMALE') ? '女' : sexType.includes('MALE') ? '男' : '';
}

export function cleanMedicineName(name: string): string {
  if (!name) return '';
  return name
    .replace(/「[^」]+」/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s: string) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.').replace(/，/g, ',').replace(/\s+/g, ' ')
    .replace(/(\d+\.?\d*)\s+\1/g, '$1')
    .trim();
}

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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

// ====================
// DATA_QUERIES（extension/core/henry_data.ts より逐語）
// ====================

const Q_GET_PATIENT = `
  query GetPatient($input: GetPatientRequestInput!) {
    getPatient(input: $input) {
      uuid
      serialNumber
      serialNumberPrefix
      fullName
      fullNamePhonetic
      detail {
        birthDate { year month day }
        sexType
        postalCode
        addressLine_1
        phoneNumber
        memo
      }
    }
  }`;

const Q_LIST_HOSPITALIZATIONS = `
  query ListPatientHospitalizations($input: ListPatientHospitalizationsRequestInput!) {
    listPatientHospitalizations(input: $input) {
      hospitalizations {
        uuid
        state
        startDate { year month day }
        endDate { year month day }
        hospitalizationDayCount { value }
        lastHospitalizationLocation {
          ward { name }
          room { name }
        }
        hospitalizationDoctor {
          doctor { name }
        }
      }
    }
  }`;

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
        intractableDiseaseType
        patientCareType
        masterDisease { name code }
        masterModifiers { name code position }
        customDiseaseName { value }
        isDraft
      }
    }
  }`;

const Q_LIST_CLINICAL_DOCUMENTS = `
  query ListClinicalDocuments($input: ListClinicalDocumentsRequestInput!) {
    listClinicalDocuments(input: $input) {
      documents {
        uuid
        editorData
        performTime { seconds }
        updateTime { seconds }
        creatorUuid
        creator { name }
        type {
          type
          __typename
          clinicalDocumentCustomTypeUuid { value }
        }
      }
      nextPageToken
    }
  }`;

// ====================
// データ収集（henry_discharge_summary.ts の各 fetch 関数を移植）
// ====================

export async function getPatient(patientUuid: string): Promise<HenryPatient | null> {
  if (!patientUuid) return null;
  const data = await query<{ getPatient?: HenryPatient }>(Q_GET_PATIENT, { input: { uuid: patientUuid } });
  return data.getPatient || null;
}

/** 対象の入院情報を取得（入院中 → 最新の退院済み の優先順） */
export async function getTargetHospitalization(patientUuid: string): Promise<HenryHospitalization | null> {
  const data = await query<{ listPatientHospitalizations?: { hospitalizations?: HenryHospitalization[] } }>(
    Q_LIST_HOSPITALIZATIONS,
    { input: { patientUuid, pageSize: 10, pageToken: '' } },
  );
  const hospitalizations = data.listPatientHospitalizations?.hospitalizations || [];
  return (
    hospitalizations.find(
      (h) => h.state === 'HOSPITALIZED' || h.state === 'ADMITTED' || h.state === 'WILL_DISCHARGE',
    ) || hospitalizations[0] || null
  );
}

/**
 * 指定された入院日に一致する入院情報を取得（FF1検証用）
 * 完全一致しない場合は近い入院日（±3日以内）の候補を返す
 */
export async function getHospitalizationByAdmissionDate(
  patientUuid: string,
  admissionDateIso: string,
): Promise<HenryHospitalization | null> {
  const data = await query<{ listPatientHospitalizations?: { hospitalizations?: HenryHospitalization[] } }>(
    Q_LIST_HOSPITALIZATIONS,
    { input: { patientUuid, pageSize: 20, pageToken: '' } },
  );
  const hospitalizations = data.listPatientHospitalizations?.hospitalizations || [];

  const targetMs = new Date(admissionDateIso).getTime();
  if (isNaN(targetMs)) return null;

  // 完全一致を最優先
  const exact = hospitalizations.find((h) => {
    if (!h.startDate) return false;
    const sd = `${h.startDate.year}-${String(h.startDate.month).padStart(2, '0')}-${String(h.startDate.day).padStart(2, '0')}`;
    return sd === admissionDateIso;
  });
  if (exact) return exact;

  // ±3日以内の候補
  for (const h of hospitalizations) {
    if (!h.startDate) continue;
    const ms = new Date(h.startDate.year, h.startDate.month - 1, h.startDate.day).getTime();
    if (Math.abs(ms - targetMs) <= 3 * 24 * 60 * 60 * 1000) return h;
  }
  return null;
}

/** 入院主病名を取得 */
export async function fetchMainDisease(patientUuid: string): Promise<string> {
  const data = await query<{ listPatientReceiptDiseases?: { patientReceiptDiseases?: HenryDisease[] } }>(
    Q_LIST_DISEASES,
    { input: { patientUuids: [patientUuid], patientCareType: 'PATIENT_CARE_TYPE_INPATIENT', onlyMain: false } },
  );
  const diseases = data.listPatientReceiptDiseases?.patientReceiptDiseases || [];
  const main = diseases.find((d) => d.isMain && d.patientUuid === patientUuid);
  if (!main) return '未登録';
  const base = main.masterDisease?.name || '';
  const prefixes = (main.masterModifiers || []).filter((m) => m.position === 'PREFIX').map((m) => m.name).join('');
  const suffixes = (main.masterModifiers || []).filter((m) => m.position === 'SUFFIX').map((m) => m.name).join('');
  return prefixes + base + suffixes || '未登録';
}

interface ClinicalDocsResponse {
  listClinicalDocuments?: {
    documents?: HenryClinicalDocument[];
    nextPageToken?: string | null;
  };
}

/** 臨床文書を全件取得（ページネーション対応） */
async function fetchAllClinicalDocuments(
  patientUuid: string,
  types: Array<{ type: string; clinicalDocumentCustomTypeUuid?: { value: string } }>,
): Promise<HenryClinicalDocument[]> {
  const allDocs: HenryClinicalDocument[] = [];
  let pageToken: string | null = '';
  while (pageToken !== null) {
    const res: ClinicalDocsResponse = await query<ClinicalDocsResponse>(
      Q_LIST_CLINICAL_DOCUMENTS,
      { input: { patientUuid, clinicalDocumentTypes: types, pageSize: 50, pageToken } },
    );
    allDocs.push(...(res.listClinicalDocuments?.documents || []));
    // API は完了時に空文字 '' を返すため `|| null` で終端（`?? null` だと '' で無限ループ）
    pageToken = res.listClinicalDocuments?.nextPageToken || null;
  }
  return allDocs;
}

/** 臨床文書を一括取得し、種別ごとに仕分ける */
export async function fetchClinicalRecords(patientUuid: string): Promise<{
  doctorRecords: Array<{ date: string; text: string; author: string }>;
  nursingRecords: Array<{ date: string; text: string }>;
  profile: string;
}> {
  const allDocs = await fetchAllClinicalDocuments(patientUuid, [
    { type: 'HOSPITALIZATION_CONSULTATION' },
    { type: 'CUSTOM', clinicalDocumentCustomTypeUuid: { value: NURSING_RECORD_CUSTOM_TYPE_UUID } },
    { type: 'CUSTOM', clinicalDocumentCustomTypeUuid: { value: PATIENT_PROFILE_CUSTOM_TYPE_UUID } },
  ]);

  const doctorRecords = allDocs
    .filter((doc) => doc.type?.type === 'HOSPITALIZATION_CONSULTATION')
    .map((doc) => ({
      date: doc.performTime?.seconds ? toIsoDate(new Date(doc.performTime.seconds * 1000)) : '不明',
      text: parseEditorData(doc.editorData),
      author: doc.creator?.name || '',
    }))
    .filter((r) => r.text);

  const nursingRecords = allDocs
    .filter((doc) => doc.type?.clinicalDocumentCustomTypeUuid?.value === NURSING_RECORD_CUSTOM_TYPE_UUID)
    .map((doc) => ({
      date: doc.performTime?.seconds ? toIsoDate(new Date(doc.performTime.seconds * 1000)) : '不明',
      text: parseEditorData(doc.editorData),
    }))
    .filter((r) => r.text);

  let profile = '';
  const profileDoc = allDocs
    .filter((doc) => doc.type?.clinicalDocumentCustomTypeUuid?.value === PATIENT_PROFILE_CUSTOM_TYPE_UUID)
    .find((doc) => parseEditorData(doc.editorData).includes('患者プロフィール'));
  if (profileDoc) {
    profile = parseEditorData(profileDoc.editorData, true)
      .split('\n').filter((line) => !line.includes('患者プロフィール')).join('\n');
  }

  return { doctorRecords, nursingRecords, profile };
}

export interface CalendarData {
  vitalSigns: Array<Record<string, unknown>>;
  prescriptionOrders: Array<Record<string, unknown>>;
  injectionOrders: Array<Record<string, unknown>>;
  outsideInspectionReportGroups: Array<Record<string, unknown>>;
}

/** カレンダービュー統合データ（バイタル・処方・注射・検査）を取得。インライン方式必須。 */
export async function fetchCalendarData(patientUuid: string, hospStartDate: Date): Promise<CalendarData> {
  if (!UUID_RE.test(patientUuid)) throw new Error('Invalid patient UUID format');
  const today = new Date();
  const diffDays = Math.ceil((today.getTime() - hospStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const beforeDateSize = diffDays + 1; // 入院期間すべてをカバー
  const resourcesStr = CALENDAR_RESOURCES.map((r) => `"${r}"`).join(', ');

  const graphql = `
    query GetClinicalCalendarView {
      getClinicalCalendarView(input: {
        patientUuid: "${patientUuid}",
        baseDate: { year: ${today.getFullYear()}, month: ${today.getMonth() + 1}, day: ${today.getDate()} },
        beforeDateSize: ${beforeDateSize},
        afterDateSize: 14,
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
        }
        prescriptionOrders {
          uuid
          createTime { seconds }
          startDate { year month day }
          orderStatus
          medicationCategory
          rps {
            asNeeded
            boundsDurationDays { value }
            medicationTiming {
              medicationTiming {
                canonicalPrescriptionUsage { text }
              }
            }
            instructions {
              instruction {
                medicationDosageInstruction {
                  localMedicine { name }
                  mhlwMedicine { name }
                  quantity {
                    doseQuantityPerDay { value }
                  }
                }
              }
            }
          }
        }
        injectionOrders {
          uuid
          createTime { seconds }
          orderStatus
          rps {
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
    }
  `;

  const data = await query<{ getClinicalCalendarView?: Partial<CalendarData> }>(graphql, {}, '/graphql');
  const cal = data.getClinicalCalendarView;
  return {
    vitalSigns: cal?.vitalSigns || [],
    prescriptionOrders: cal?.prescriptionOrders || [],
    injectionOrders: cal?.injectionOrders || [],
    outsideInspectionReportGroups: cal?.outsideInspectionReportGroups || [],
  };
}
