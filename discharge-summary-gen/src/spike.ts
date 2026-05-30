// 基盤スパイク: Node から Henry 認証が通り、実患者の臨床データを /graphql で取得できるか検証する。
// PII は一切出力しない（件数・真偽のみ）。
import { query } from './graphql.ts';

const PATIENT_UUID = process.argv[2] || '89b640ba-264d-411d-9df5-8c03eff76cca';

// スパイクでは最小限のリソースのみ（auth + データ到達の確認が目的）
const CALENDAR_RESOURCES = [
  '//henry-app.jp/clinicalResource/vitalSign',
  '//henry-app.jp/clinicalResource/prescriptionOrder',
];

interface CalendarView {
  getClinicalCalendarView?: {
    vitalSigns?: unknown[];
    prescriptionOrders?: unknown[];
  };
}

async function main(): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(PATIENT_UUID)) {
    throw new Error('Invalid patient UUID format');
  }
  const today = new Date();
  const resourcesStr = CALENDAR_RESOURCES.map((r) => `"${r}"`).join(', ');
  const graphql = `
    query GetClinicalCalendarView {
      getClinicalCalendarView(input: {
        patientUuid: "${PATIENT_UUID}",
        baseDate: { year: ${today.getFullYear()}, month: ${today.getMonth() + 1}, day: ${today.getDate()} },
        beforeDateSize: 120,
        afterDateSize: 0,
        clinicalResourceHrns: [${resourcesStr}],
        createUserUuids: [],
        accountingOrderShinryoShikibetsus: []
      }) {
        vitalSigns { recordTime { seconds } }
        prescriptionOrders { uuid }
      }
    }
  `;

  console.log('[spike] Henry 認証トークン取得 + /graphql 呼び出しを実行します...');
  const data = await query<CalendarView>(graphql, {}, '/graphql');
  const v = data.getClinicalCalendarView;
  console.log('[spike] OK: 認証通過 + データ取得成功（PIIは表示しません）');
  console.log('[spike] counts:', {
    vitalSigns: v?.vitalSigns?.length ?? 0,
    prescriptionOrders: v?.prescriptionOrders?.length ?? 0,
  });
}

main().catch((e) => {
  console.error('[spike] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
