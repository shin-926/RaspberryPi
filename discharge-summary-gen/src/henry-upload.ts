// Phase D: 生成した docx を Henry の患者ファイルへアップロード。
// henry_file_upload.ts / henry_drive_docs_handler.ts と同じ3ステップ:
//   GetFileUploadUrl(/graphql) → GCS へ multipart POST → CreatePatientFile(/graphql)
// window.HenryBridge.fetch は通常の fetch に置換。GCS の uploadUrl は署名URLなので認証ヘッダ不要。
import { query } from './graphql.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const Q_GET_FILE_UPLOAD_URL = `
  query GetFileUploadUrl($input: GetFileUploadUrlRequestInput!) {
    getFileUploadUrl(input: $input) {
      uploadUrl
      fileUrl
    }
  }`;

const M_CREATE_PATIENT_FILE = `
  mutation CreatePatientFile($input: CreatePatientFileRequestInput!) {
    createPatientFile(input: $input) {
      uuid
    }
  }`;

/** Henry の患者ファイルフォルダ「入院」の UUID（フォルダテンプレートは患者横断で固定）。 */
export const HOSPITALIZATION_FOLDER_UUID = 'b5b886e1-6dba-4da1-bdf6-5d02b8cc89d9';

async function getFileUploadUrl(): Promise<{ uploadUrl: string; fileUrl: string }> {
  const data = await query<{ getFileUploadUrl?: { uploadUrl: string; fileUrl: string } }>(
    Q_GET_FILE_UPLOAD_URL,
    { input: { pathType: 'PATIENT_FILE' } },
  );
  if (!data.getFileUploadUrl?.uploadUrl || !data.getFileUploadUrl?.fileUrl) {
    throw new Error('GetFileUploadUrl が uploadUrl/fileUrl を返しませんでした');
  }
  return data.getFileUploadUrl;
}

/** GCS へ multipart/form-data で POST（henry_file_upload.ts uploadToGCS と同形式） */
async function uploadToGCS(uploadUrl: string, bytes: Uint8Array, fileName: string, mimeType: string): Promise<void> {
  const boundary = '----HenryUpload' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const headerBytes = new TextEncoder().encode(header);
  const footerBytes = new TextEncoder().encode(footer);

  const body = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
  body.set(headerBytes, 0);
  body.set(bytes, headerBytes.length);
  body.set(footerBytes, headerBytes.length + bytes.length);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GCS upload failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function createPatientFile(input: {
  patientUuid: string;
  title: string;
  fileUrl: string;
  parentFileFolderUuid: string | null;
  description: string;
}): Promise<string> {
  const data = await query<{ createPatientFile?: { uuid: string } }>(M_CREATE_PATIENT_FILE, {
    input: {
      patientUuid: input.patientUuid,
      parentFileFolderUuid: input.parentFileFolderUuid ? { value: input.parentFileFolderUuid } : null,
      title: input.title,
      description: input.description,
      fileUrl: input.fileUrl,
    },
  });
  const uuid = data.createPatientFile?.uuid;
  if (!uuid) throw new Error('CreatePatientFile が uuid を返しませんでした');
  return uuid;
}

/**
 * docx を Henry 患者ファイルへアップロードし、作成された patientFileUuid を返す。
 * @param title 拡張子なしのファイル名（例: 20260529_退院サマリー）。GCS送信時のみ .docx を付与。
 * @param description patientFile.description に書き込む値。
 *   退院サマリーは `'discharge-summary'` を渡すと、編集後の保存でも一覧アプリのリンクが切れない
 *   （Henry拡張側が description マーカーを引き継ぐ仕組み）。
 */
export async function uploadDocxToHenry(
  patientUuid: string,
  docxBytes: Uint8Array,
  title: string,
  folderUuid: string | null = null,
  description: string = '',
): Promise<string> {
  const { uploadUrl, fileUrl } = await getFileUploadUrl();
  await uploadToGCS(uploadUrl, docxBytes, `${title}.docx`, DOCX_MIME);
  return createPatientFile({ patientUuid, title, fileUrl, parentFileFolderUuid: folderUuid, description });
}
