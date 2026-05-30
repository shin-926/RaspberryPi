// Phase C: Google Docs テンプレから docx を生成（手動フロー①②をサーバー側で再現）。
// ①テンプレ複製 → プレースホルダ置換(batchUpdate) → ②docx書き出し(Drive export)。
// 生成した一時Docは書き出し後に削除（無人運用でDriveを汚さない）。
import { getGoogleAccessToken } from './google-auth.ts';

// henry_discharge_summary.ts L37 のテンプレートID
export const TEMPLATE_ID = '113KwfML6f0uSuuul5I0v83C-agXlyEX5_9T3bWtbA44';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function gFetch(url: string, init: RequestInit = {}, binary = false): Promise<unknown> {
  const token = await getGoogleAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API ${res.status} (${url.split('?')[0]}): ${text.slice(0, 300)}`);
  }
  if (binary) return new Uint8Array(await res.arrayBuffer());
  if (res.status === 204) return null;
  return res.json();
}

/** テンプレートを複製し、新規ドキュメントIDを返す */
async function copyTemplate(name: string): Promise<string> {
  const result = (await gFetch(
    `https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy?supportsAllDrives=true&fields=id`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )) as { id: string };
  if (!result?.id) throw new Error('テンプレート複製に失敗（idなし）');
  return result.id;
}

/** プレースホルダ（{{key}}）を一括置換 */
async function replacePlaceholders(docId: string, replacements: Record<string, string>): Promise<void> {
  const requests = Object.entries(replacements).map(([key, value]) => ({
    replaceAllText: {
      containsText: { text: key, matchCase: true },
      replaceText: String(value ?? ''),
    },
  }));
  await gFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
}

// ---- docx書き出し前の体裁補正（henry_discharge_summary.ts の後処理を移植）----

interface DocStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
  table?: { tableRows: Array<{ tableCells: Array<{ content: DocStructuralElement[] }> }> };
}

function collectParagraphs(content: DocStructuralElement[], out: DocStructuralElement[]): void {
  for (const el of content) {
    if (el.paragraph) out.push(el);
    if (el.table) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells) collectParagraphs(cell.content, out);
      }
    }
  }
}

function paraText(p: DocStructuralElement): string {
  return p.paragraph?.elements?.map((e) => e.textRun?.content || '').join('') || '';
}

/**
 * docx書き出し前に Google Doc の体裁を補正する:
 *  ① 現病歴セルのラベル段落（主訴/現病歴/既往歴/入院時）にぶら下げインデントを明示設定
 *     （DOCX往復で indentFirstLine が indentStart に同値化し段落全体がずれる現象の対策）
 *  ② プロブレムリスト（#N 見出し）の段落スペースを整える
 * applyAnamnesisIndents / applyProblemListSpacing（henry_discharge_summary.ts）を移植。
 */
async function applyDischargeFormatting(docId: string): Promise<void> {
  const doc = (await gFetch(`https://docs.googleapis.com/v1/documents/${docId}`)) as {
    body?: { content?: DocStructuralElement[] };
  };
  const paragraphs: DocStructuralElement[] = [];
  collectParagraphs(doc.body?.content || [], paragraphs);

  const requests: unknown[] = [];

  // ① ラベル段落のインデント（1.25cm = 35.43pt）
  const INDENT_START_PT = (1.25 / 2.54) * 72;
  const labelRe = /^【(主.*訴|現病歴|既往歴|入院時)】/;
  for (const para of paragraphs) {
    if (para.startIndex == null || para.endIndex == null) continue;
    if (labelRe.test(paraText(para))) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: para.startIndex, endIndex: para.endIndex },
          paragraphStyle: {
            indentStart: { magnitude: INDENT_START_PT, unit: 'PT' },
            indentFirstLine: { magnitude: 0, unit: 'PT' },
          },
          fields: 'indentStart,indentFirstLine',
        },
      });
    }
  }

  // ② プロブレムリストの段落スペース
  const headingIndices: number[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (/^#\d+ /.test(paraText(paragraphs[i]))) headingIndices.push(i);
  }
  const setSpace = (paraIdx: number, field: 'spaceBelow' | 'spaceAbove', magnitude: number) => {
    const para = paragraphs[paraIdx];
    if (!para || para.startIndex == null || para.endIndex == null) return;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: para.startIndex, endIndex: para.endIndex },
        paragraphStyle: { [field]: { magnitude, unit: 'PT' } },
        fields: field,
      },
    });
  };
  for (let h = 0; h < headingIndices.length; h++) {
    const headingIdx = headingIndices[h];
    setSpace(headingIdx, 'spaceBelow', 0);
    if (headingIdx + 1 < paragraphs.length) setSpace(headingIdx + 1, 'spaceAbove', 0);
    const nextHeadingIdx = headingIndices[h + 1];
    if (nextHeadingIdx != null) {
      setSpace(nextHeadingIdx - 1, 'spaceBelow', 7);
    } else if (headingIdx + 1 < paragraphs.length) {
      setSpace(headingIdx + 1, 'spaceBelow', 7);
    }
  }

  if (requests.length > 0) {
    await gFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  }
}

/** ドキュメントを docx バイト列として書き出す */
async function exportDocx(docId: string): Promise<Uint8Array> {
  return (await gFetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=${encodeURIComponent(DOCX_MIME)}`,
    {},
    true,
  )) as Uint8Array;
}

/** 一時ドキュメントを削除（失敗しても致命的ではない） */
async function deleteDoc(docId: string): Promise<void> {
  try {
    await gFetch(`https://www.googleapis.com/drive/v3/files/${docId}?supportsAllDrives=true`, { method: 'DELETE' });
  } catch (e) {
    console.warn('[google-docs] 一時Doc削除失敗（無視）:', e instanceof Error ? e.message : e);
  }
}

/**
 * テンプレから退院サマリー docx を生成して返す。
 * docName: 一時Docの名前（Drive上）。最終的なカルテ上のタイトルは呼び出し側で指定。
 */
export async function renderDischargeSummaryDocx(
  docName: string,
  replacements: Record<string, string>,
): Promise<Uint8Array> {
  const docId = await copyTemplate(docName);
  try {
    await replacePlaceholders(docId, replacements);
    // docx書き出し前にラベル段落のインデント・プロブレムリストのスペースを補正
    await applyDischargeFormatting(docId);
    const bytes = await exportDocx(docId);
    return bytes;
  } finally {
    await deleteDoc(docId);
  }
}
