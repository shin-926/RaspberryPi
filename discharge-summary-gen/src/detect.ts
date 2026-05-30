// Phase E: 退院検知。ListPatientsV2(DISCHARGED) で直近退院者を取得し、
// listPatientFiles で「退院サマリ」未作成の患者を生成対象として抽出する。
// （henry_discharge_summary_sync.ts の Phase1/2 を踏襲。冪等性は「退院サマリ」ファイルの有無で担保）
import { query } from './graphql.ts';
import type { HenryDate } from './types.ts';

const SUMMARY_KEYWORD = '退院サマリ';
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

const FILES_Q = `
  query ListPatientFiles($patientId: ID!, $parentFolderId: ID, $searchQuery: String, $pageSize: Int!, $pageToken: String!) {
    listPatientFiles(patientId: $patientId, parentFolderId: $parentFolderId, searchQuery: $searchQuery, pageSize: $pageSize, pageToken: $pageToken) {
      patientFiles { id title createTime fileType }
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

/** 患者が「退院サマリ」を含むファイルを既に持っているか */
async function hasDischargeSummaryFile(patientUuid: string): Promise<boolean> {
  let pageToken = '';
  do {
    const data = await query<{ listPatientFiles?: { patientFiles?: Array<{ title?: string }>; nextPageToken?: string } }>(
      FILES_Q,
      { patientId: patientUuid, parentFolderId: null, searchQuery: null, pageSize: PAGE_SIZE, pageToken },
      '/graphql-v2',
    );
    for (const f of data.listPatientFiles?.patientFiles || []) {
      if ((f.title || '').includes(SUMMARY_KEYWORD)) return true;
    }
    pageToken = data.listPatientFiles?.nextPageToken || '';
  } while (pageToken);
  return false;
}

export interface DetectResult {
  totalDischarged: number;
  inWindow: number;
  alreadyHasSummary: number;
  targets: DischargeTarget[];
}

/**
 * 直近 windowDays 日以内に退院し、まだ「退院サマリ」ファイルが無い患者を抽出する。
 * サーバー負荷軽減のため listPatientFiles は逐次 + sleep。
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
    if (await hasDischargeSummaryFile(g.patientUuid)) {
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
