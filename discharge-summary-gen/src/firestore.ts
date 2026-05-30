// Phase E: 生成した退院サマリーを Firestore (discharge_summaries) に登録（REST方式）。
// 認証は拡張と同じく Henry Custom Token ブリッジ → maokahp-webapps idToken。
// doc id = patientFileUuid（既存 sync と同一規約）。
// aiGenerated:true / reviewed:false を付与 → 一覧アプリ(Phase F)で「AI下書き・未確認」表示。
import { getWebappsSession, webappsFirestoreFetch } from './webapps-auth.ts';

export interface DischargeSummaryRecord {
  patientFileUuid: string;
  patientUuid: string;
  patientSerialNumber: string;
  patientName: string;
  patientNamePhonetic: string;
  birthDate: string;
  sex: string;
  admissionDate: string;
  dischargeDate: string;
  dischargeDestination: string;
  doctorName: string;
  fileTitle: string;
  fileType: string;
}

export async function registerDischargeSummary(rec: DischargeSummaryRecord): Promise<void> {
  // 監査用の updatedBy（=Henryの自分のuid）を取るためにセッションを参照
  const session = await getWebappsSession();
  const fields = {
    patientUuid: { stringValue: rec.patientUuid },
    patientFileUuid: { stringValue: rec.patientFileUuid },
    patientSerialNumber: { stringValue: rec.patientSerialNumber },
    patientName: { stringValue: rec.patientName },
    patientNamePhonetic: { stringValue: rec.patientNamePhonetic },
    birthDate: { stringValue: rec.birthDate },
    sex: { stringValue: rec.sex },
    admissionDate: { stringValue: rec.admissionDate },
    dischargeDate: { stringValue: rec.dischargeDate },
    dischargeDestination: { stringValue: rec.dischargeDestination || '' },
    doctorName: { stringValue: rec.doctorName },
    fileTitle: { stringValue: rec.fileTitle },
    fileType: { stringValue: rec.fileType },
    // Phase F のレビュー追跡
    aiGenerated: { booleanValue: true },
    reviewed: { booleanValue: false },
    reviewedBy: { stringValue: '' },
    reviewedByName: { stringValue: '' },
    reviewedAt: { nullValue: null },
    updatedAt: { timestampValue: new Date().toISOString() },
    updatedBy: { stringValue: session.uid },
  };

  const res = await webappsFirestoreFetch(`discharge_summaries/${rec.patientFileUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`discharge_summaries 登録に失敗 (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  }
}
