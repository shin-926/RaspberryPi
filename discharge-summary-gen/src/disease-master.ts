// 病名マスター（code ↔ ICD-10）の取得・キャッシュ
//
// Henry本体は IndexedDB にマスタをキャッシュして window.HENRY_DISEASES で
// 検索しているが、サーバサイドではこのモジュールでマップを構築する。
//
// データ構造: HENRY_DISEASES = [[code, icd10, name, kana], ...]
// 件数: 約 27,000 件
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DATA_URL = 'https://sk924.com/henry/1f5b3474c05b3839/main/henry_disease_data.js';
const CACHE_PATH = process.env.DISEASE_MASTER_CACHE || resolve(process.cwd(), '_cache/disease-master.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日

export interface DiseaseMaster {
  byCode: Map<string, { icd10: string; name: string; kana: string }>;
  loadedAt: number;
}

let _cache: DiseaseMaster | null = null;

/** マスタをfetchまたはキャッシュから読み込む */
export async function loadDiseaseMaster(): Promise<DiseaseMaster> {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache;

  // ディスクキャッシュ
  if (existsSync(CACHE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as { entries: Array<[string, string, string, string]>; loadedAt: number };
      if (Date.now() - raw.loadedAt < CACHE_TTL_MS) {
        _cache = entriesToMaster(raw.entries, raw.loadedAt);
        console.log(`[disease-master] ディスクキャッシュから読み込み: ${_cache.byCode.size}件`);
        return _cache;
      }
    } catch (e) {
      console.warn('[disease-master] キャッシュ読み込み失敗、再取得します', e instanceof Error ? e.message : e);
    }
  }

  // サーバから取得
  console.log(`[disease-master] サーバから取得: ${DATA_URL}`);
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`病名マスタ取得失敗: HTTP ${res.status}`);
  const text = await res.text();

  // `window.HENRY_DISEASES = [...];` から配列だけ抽出
  const match = text.match(/window\.HENRY_DISEASES\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error('病名マスタの構造解析失敗');
  const entries = JSON.parse(match[1]) as Array<[string, string, string, string]>;
  const loadedAt = Date.now();

  // ディスクキャッシュ保存
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ entries, loadedAt }));
  } catch (e) {
    console.warn('[disease-master] キャッシュ保存失敗', e instanceof Error ? e.message : e);
  }

  _cache = entriesToMaster(entries, loadedAt);
  console.log(`[disease-master] マスタ取得完了: ${_cache.byCode.size}件`);
  return _cache;
}

function entriesToMaster(
  entries: Array<[string, string, string, string]>,
  loadedAt: number,
): DiseaseMaster {
  const byCode = new Map<string, { icd10: string; name: string; kana: string }>();
  for (const [code, icd10, name, kana] of entries) {
    byCode.set(code, { icd10, name, kana });
  }
  return { byCode, loadedAt };
}

/** code → ICD-10 を取得（見つからない or 空なら 空文字） */
export function codeToIcd10(master: DiseaseMaster, code: string): string {
  return master.byCode.get(code)?.icd10 || '';
}

// 動作テスト
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const m = await loadDiseaseMaster();
    console.log(`総件数: ${m.byCode.size}`);
    for (const code of ['5301002', '8842618', '2500013', '0000999']) {
      const v = m.byCode.get(code);
      console.log(`${code}: ${v ? `ICD=${v.icd10} 名前=${v.name}` : '未登録'}`);
    }
  })();
}
