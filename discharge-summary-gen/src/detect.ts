// Phase E: 退院検知。ListPatientsV2(DISCHARGED) で直近退院者を取得し、
// Firestore discharge_summaries で「同入院のサマリ未生成」の患者を抽出する。
//
// 冪等性の source of truth は Firestore (discharge_summaries) コレクション。
// 以前は Henry の listPatientFiles でタイトル一致を見ていたが、
// listPatientFiles(parentFolderId: null) はルート直下しか返さず、
// サマリは入院フォルダにアップロードされるため検知をすり抜けて毎日重複生成していた。
// （Henry拡張の henry_drive_docs_handler.ts:293 にも同じ注意書きあり）
// → Firestore に「同 patientUuid + admissionDate」のドキュメントが既にあれば skip。
import { query } from './graphql.ts';
import { webappsFirestoreRunQuery } from './webapps-auth.ts';
import { formatHenryDate } from './collect.ts';
import type { HenryDate } from './types.ts';

const EXCLUDE_NAME_RE = /テスト|操作確認|動作確認/;
const PAGE_SIZE = 100;
const READ_DELAY_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PATIENTS_Q = `
  query ListPatientsV2($input: ListPatientsV2RequestInput!) {
    listPatientsV2(input: $input) {
      entries {
        patient { uuid serialNumber fullName fullNamePhonetic detail { sexType birthDate { year month day } } }
        hospitalization { startDate { year month day } endDate { year month day } hospitalizationDoctor { doctor { name } } }
      }
      nextPageToken
    }
  }`;

interface Hospitalization {
  startDate: HenryDate | null;
  endDate: HenryDate | null;
  doctorName: string;
}

export interface DischargeTarget {
  patientUuid: string;
  serialNumber: string;
  fullName: string;
  fullNamePhonetic: string;
  birthDate: HenryDate | null;
  sexType: string;
  /** サマリー対象の入院（最新の退院済み） */
  admissionDate: HenryDate | null;
  dischargeDate: HenryDate | null;
  doctorName: string;
}

interface PatientGroup extends DischargeTarget {
  hospitalizations: Hospitalization[];
}

function dateToMs(d: HenryDate | null): number | null {
  if (!d || !d.year) return null;
  return new Date(d.year, (d.month || 1) - 1, d.day || 1).getTime();
}

/** 退院済み患者を全件取得し patientUuid で集約（最新退院日を採用） */
async function fetchDischargedPatients(): Promise<PatientGroup[]> {
  const groups = new Map<string, PatientGroup>();
  let pageToken = '';
  do {
    const data = await query<{
      listPatientsV2?: {
        entries?: Array<{
          patient: { uuid: string; serialNumber?: string; fullName?: string; fullNamePhonetic?: string; detail?: { sexType?: string; birthDate?: HenryDate | null } };
          hospitalization?: { startDate?: HenryDate | null; endDate?: HenryDate | null; hospitalizationDoctor?: { doctor?: { name?: string } } };
        }>;
        nextPageToken?: string;
      };
    }>(PATIENTS_Q, {
      input: {
        generalFilter: { query: '', patientCareType: 'PATIENT_CARE_TYPE_ANY' },
        hospitalizationFilter: { doctorUuid: null, roomUuids: [], wardUuids: [], states: ['DISCHARGED'], onlyLatest: false },
        sorts: [{ sortField: 'SORT_FIELD_HOSPITALIZATION_DISCHARGE_DATE', sortOrder: 'SORT_ORDER_DESC' }],
        pageSize: PAGE_SIZE,
        pageToken,
      },
    });
    const entries = data.listPatientsV2?.entries || [];
    for (const e of entries) {
      const p = e.patient;
      if (!p?.uuid) continue;
      if (EXCLUDE_NAME_RE.test(p.fullName || '')) continue;
      let g = groups.get(p.uuid);
      if (!g) {
        g = {
          patientUuid: p.uuid,
          serialNumber: p.serialNumber || '',
          fullName: p.fullName || '',
          fullNamePhonetic: p.fullNamePhonetic || '',
          birthDate: p.detail?.birthDate ?? null,
          sexType: p.detail?.sexType || '',
          admissionDate: null,
          dischargeDate: null,
          doctorName: '',
          hospitalizations: [],
        };
        groups.set(p.uuid, g);
      }
      if (e.hospitalization) {
        g.hospitalizations.push({
          startDate: e.hospitalization.startDate ?? null,
          endDate: e.hospitalization.endDate ?? null,
          doctorName: e.hospitalization.hospitalizationDoctor?.doctor?.name || '',
        });
      }
    }
    pageToken = data.listPatientsV2?.nextPageToken || '';
    if (pageToken) await sleep(READ_DELAY_MS);
  } while (pageToken);

  // 各患者の「最新の退院」を採用
  for (const g of groups.values()) {
    let latest: Hospitalization | null = null;
    let latestMs = -Infinity;
    for (const h of g.hospitalizations) {
      const ms = dateToMs(h.endDate);
      if (ms != null && ms > latestMs) { latestMs = ms; latest = h; }
    }
    if (latest) {
      g.admissionDate = latest.startDate;
      g.dischargeDate = latest.endDate;
      g.doctorName = latest.doctorName;
    }
  }
  return [...groups.values()];
}

/**
 * Firestore discharge_summaries に「同 patientUuid + admissionDate」のレコードが既にあるか。
 * 同一入院に対する重複生成だけを止めたいので admissionDate も突き合わせる
 * （過去の別入院のサマリが残っていても、今回の入院は生成対象）。
 *
 * 単一フィールド (patientUuid) の同値クエリだけで済ませて、admissionDate はクライアント側で照合する。
 * 患者ごとの過去サマリ件数は高々数件なので複合インデックスは不要。
 */
async function hasFirestoreSummary(patientUuid: string, admissionDateStr: string): Promise<boolean> {
  if (!admissionDateStr) return false; // 入院日が取れない場合は冪等性を諦め、後段の処理に任せる
  const results = await webappsFirestoreRunQuery({
    from: [{ collectionId: 'discharge_summaries' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'patientUuid' },
        op: 'EQUAL',
        value: { stringValue: patientUuid },
      },
    },
    limit: 20,
  });
  for (const row of results) {
    const fields = row.document?.fields;
    if (!fields) continue;
    if (fields.admissionDate?.stringValue === admissionDateStr) return true;
  }
  return false;
}

export interface DetectResult {
  totalDischarged: number;
  inWindow: number;
  alreadyHasSummary: number;
  targets: DischargeTarget[];
}

/**
 * 直近 windowDays 日以内に退院し、まだサマリ未生成の患者を抽出する。
 * サーバー負荷軽減のため Firestore クエリは逐次 + sleep。
 */
export async function detectTargets(windowDays: number): Promise<DetectResult> {
  const all = await fetchDischargedPatients();
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const inWindow = all.filter((g) => {
    const ms = dateToMs(g.dischargeDate);
    return ms != null && now - ms <= windowMs;
  });

  const targets: DischargeTarget[] = [];
  let alreadyHasSummary = 0;
  for (const g of inWindow) {
    await sleep(READ_DELAY_MS);
    if (await hasFirestoreSummary(g.patientUuid, formatHenryDate(g.admissionDate))) {
      alreadyHasSummary++;
      continue;
    }
    targets.push({
      patientUuid: g.patientUuid,
      serialNumber: g.serialNumber,
      fullName: g.fullName,
      fullNamePhonetic: g.fullNamePhonetic,
      birthDate: g.birthDate,
      sexType: g.sexType,
      admissionDate: g.admissionDate,
      dischargeDate: g.dischargeDate,
      doctorName: g.doctorName,
    });
  }

  return { totalDischarged: all.length, inWindow: inWindow.length, alreadyHasSummary, targets };
}
