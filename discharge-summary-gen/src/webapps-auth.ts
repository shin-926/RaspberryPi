// maokahp-webapps の Firebase Auth セッション管理（Custom Token ブリッジ）。
// 拡張の wardBoardAuth.ts を Node 用に移植。
//
// 流れ:
//   1. 匿名サインインで anonUid を得る
//   2. authBridgeRequests/{anonUid} に Henry の idToken + status:'pending' を書く
//   3. Cloud Function が Henry token を検証し customToken を Firestore に書き戻す
//   4. polling で受領した customToken で signInWithCustomToken → idToken/refreshToken
//   5. 以降は refresh token で永続更新
//
// セキュリティ: PII（氏名等）は保存しない。tokens + uid のみ .secrets にmode 600で保存。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from './env.ts';
import { getHenryIdToken } from './henry-auth.ts';

const PROJECT_ID = env.firebaseProjectId; // 'maokahp-webapps'
// Firebase Web API key は公開前提（拡張に同梱されている値）。セキュリティは Firestore ルール + Auth で担保。
const API_KEY = process.env.MAOKAHP_FIREBASE_API_KEY || 'AIzaSyAs06X1IdEQNzLfj2OvsdwLLikoDxSUi2w';

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN_BASE = 'https://securetoken.googleapis.com/v1';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

const CACHE_PATH = resolve(env.rootDir, process.env.WEBAPPS_SESSION_CACHE_PATH || './.secrets/webapps-session.json');

export interface WebappsSession {
  idToken: string;
  refreshToken: string;
  /** idToken の有効期限 (epoch ms) */
  expiresAt: number;
  /** Firebase Auth uid = Henry user UUID */
  uid: string;
}

// ============================================================
// Firestore REST 値変換
// ============================================================

interface FirestoreField {
  stringValue?: string;
  integerValue?: string;
  booleanValue?: boolean;
  timestampValue?: string;
  nullValue?: null;
}

function readFirestoreField(field: FirestoreField | undefined): unknown {
  if (!field) return undefined;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.nullValue !== undefined) return null;
  return undefined;
}

// ============================================================
// fetch ラッパ
// ============================================================

export interface RestResult {
  ok: boolean;
  status: number;
  body: string;
}

async function rest(url: string, init: RequestInit = {}): Promise<RestResult> {
  const res = await fetch(url, init);
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function restJson<T = unknown>(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T | null }> {
  const r = await rest(url, init);
  let data: T | null = null;
  if (r.body) { try { data = JSON.parse(r.body) as T; } catch { /* leave null */ } }
  return { ok: r.ok, status: r.status, data };
}

// ============================================================
// Firebase Auth REST
// ============================================================

interface SignUpResponse { idToken: string; refreshToken: string; expiresIn: string; localId: string; }
interface SignInResponse { idToken: string; refreshToken: string; expiresIn: string; }
interface RefreshResponse { id_token: string; refresh_token: string; expires_in: string; user_id: string; }

async function signInAnonymously(): Promise<SignUpResponse> {
  const r = await restJson<SignUpResponse>(`${IDENTITY_BASE}/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok || !r.data?.idToken || !r.data?.localId) {
    throw new Error(`匿名サインインに失敗 (HTTP ${r.status})`);
  }
  return r.data;
}

async function signInWithCustomTokenRest(customToken: string): Promise<SignInResponse> {
  const r = await restJson<SignInResponse>(`${IDENTITY_BASE}/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  if (!r.ok || !r.data?.idToken) {
    throw new Error(`Custom Token サインインに失敗 (HTTP ${r.status})`);
  }
  return r.data;
}

async function refreshIdTokenRest(refreshToken: string): Promise<RefreshResponse> {
  const r = await restJson<RefreshResponse>(`${SECURETOKEN_BASE}/token?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!r.ok || !r.data?.id_token) {
    throw new Error(`maokahp-webapps token refresh 失敗 (HTTP ${r.status})`);
  }
  return r.data;
}

// ============================================================
// Bridge: anon → Henry token 提出 → customToken 受領
// ============================================================

interface BridgeDocFields {
  status?: FirestoreField;
  customToken?: FirestoreField;
  error?: FirestoreField;
}

async function performBridge(anonIdToken: string, anonUid: string, henryIdToken: string): Promise<string> {
  const docUrl = `${FIRESTORE_BASE}/authBridgeRequests/${anonUid}`;
  const authHeader = `Bearer ${anonIdToken}`;

  // PATCH で create（CF は onDocumentCreated トリガ）
  const createRes = await rest(docUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      fields: {
        idToken: { stringValue: henryIdToken },
        status: { stringValue: 'pending' },
      },
    }),
  });
  if (!createRes.ok) {
    throw new Error(`認証リクエスト送信に失敗 (HTTP ${createRes.status}): ${createRes.body.slice(0, 200)}`);
  }

  // CF の処理を polling
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await restJson<{ fields?: BridgeDocFields }>(docUrl, {
      method: 'GET',
      headers: { 'Authorization': authHeader },
    });
    if (!r.ok || !r.data?.fields) continue;
    const status = readFirestoreField(r.data.fields.status) as string | undefined;
    if (status === 'completed') {
      const customToken = readFirestoreField(r.data.fields.customToken) as string | undefined;
      if (!customToken) throw new Error('認証完了したが customToken が含まれていません');
      return customToken;
    }
    if (status === 'failed') {
      const errMsg = readFirestoreField(r.data.fields.error) as string | undefined;
      throw new Error(`認証ブリッジ失敗: ${errMsg ?? 'unknown'}`);
    }
  }
  throw new Error('認証ブリッジがタイムアウト');
}

// ============================================================
// JWT decode（uid 抽出のみ・検証なし。検証は Firebase 側で済）
// ============================================================

function decodeJwtUid(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8')) as { sub?: string; user_id?: string };
    return payload.sub ?? payload.user_id ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// セッションキャッシュ（.secrets/webapps-session.json）
// ============================================================

let _memCache: WebappsSession | null = null;

function loadCache(): WebappsSession | null {
  if (_memCache) return _memCache;
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as WebappsSession;
    if (!s.idToken || !s.refreshToken || !s.uid) return null;
    _memCache = s;
    return s;
  } catch {
    return null;
  }
}

function saveCache(session: WebappsSession): void {
  _memCache = session;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
}

function clearCache(): void {
  _memCache = null;
  try { if (existsSync(CACHE_PATH)) writeFileSync(CACHE_PATH, ''); } catch { /* ignore */ }
}

// ============================================================
// Public API
// ============================================================

let _sessionPromise: Promise<WebappsSession> | null = null;

/** maokahp-webapps Firebase セッションを取得する。キャッシュ→refresh→ブリッジの順。 */
export async function getWebappsSession(): Promise<WebappsSession> {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    const now = Date.now();
    const cached = loadCache();
    if (cached && now < cached.expiresAt - REFRESH_BUFFER_MS) return cached;

    if (cached?.refreshToken) {
      try {
        const r = await refreshIdTokenRest(cached.refreshToken);
        const next: WebappsSession = {
          idToken: r.id_token,
          refreshToken: r.refresh_token,
          expiresAt: Date.now() + parseInt(r.expires_in, 10) * 1000,
          uid: r.user_id,
        };
        saveCache(next);
        return next;
      } catch (e) {
        console.warn('[webapps-auth] refresh失敗、ブリッジから再取得:', e instanceof Error ? e.message : e);
        clearCache();
      }
    }

    // フルブリッジ: Henry token → anon → CF → customToken → signIn
    const henryToken = await getHenryIdToken();
    const anon = await signInAnonymously();
    const customToken = await performBridge(anon.idToken, anon.localId, henryToken);
    const signed = await signInWithCustomTokenRest(customToken);
    const next: WebappsSession = {
      idToken: signed.idToken,
      refreshToken: signed.refreshToken,
      expiresAt: Date.now() + parseInt(signed.expiresIn, 10) * 1000,
      uid: decodeJwtUid(signed.idToken) ?? '',
    };
    saveCache(next);
    return next;
  })().finally(() => { _sessionPromise = null; });
  return _sessionPromise;
}

/** Firestore REST を maokahp-webapps の idToken で呼ぶ。Authorization は自動付与。 */
export async function webappsFirestoreFetch(path: string, init: RequestInit = {}): Promise<RestResult> {
  const session = await getWebappsSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
    'Authorization': `Bearer ${session.idToken}`,
  };
  return rest(`${FIRESTORE_BASE}/${path}`, { ...init, headers });
}
