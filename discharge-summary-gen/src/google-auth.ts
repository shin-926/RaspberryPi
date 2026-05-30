// Google OAuth: 拡張の refresh_token を流用してサーバー側でアクセストークンを更新する。
// henry_google_auth.ts の directRefreshToken（oauth2.googleapis.com/token）と同等の素のHTTP。
//
// 拡張側で Google が refresh_token を rotation する場合があり、.env の値が陳腐化して
// invalid_grant になる事故が起きうる。これを防ぐため、refresh 応答に refresh_token が
// 含まれていたらキャッシュに保存し、次回以降は env よりキャッシュを優先する。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.ts';

interface GoogleTokenCache {
  accessToken: string;
  /** Google が rotation した最新の refresh_token（無ければ env.googleRefreshToken を使う） */
  refreshToken?: string;
  expiresAt: number;
}

let memoryCache: GoogleTokenCache | null = null;

function readCache(): GoogleTokenCache | null {
  if (memoryCache) return memoryCache;
  if (!existsSync(env.googleTokenCachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(env.googleTokenCachePath, 'utf8')) as GoogleTokenCache;
    memoryCache = data;
    return data;
  } catch {
    return null;
  }
}

function writeCache(cache: GoogleTokenCache): void {
  memoryCache = cache;
  mkdirSync(dirname(env.googleTokenCachePath), { recursive: true });
  writeFileSync(env.googleTokenCachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export async function getGoogleAccessToken(): Promise<string> {
  const cached = readCache();
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  // キャッシュにある rotation 後の refresh_token を優先。なければ env のもの。
  const refreshToken = cached?.refreshToken || env.googleRefreshToken;
  if (!refreshToken) {
    throw new Error('GOOGLE_REFRESH_TOKEN が未設定で、キャッシュにも refresh_token がありません。');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    const detail = [data.error, data.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
    throw new Error(`Google token refresh failed: ${detail}`);
  }

  // Google が新しい refresh_token を返したら（rotation）、それをキャッシュに保存して次回以降優先する。
  const rotated = data.refresh_token && data.refresh_token !== refreshToken;
  if (rotated) {
    console.warn('[google-auth] Google が refresh_token を rotation しました（キャッシュに保存）。.env の値はいずれ古くなります。');
  }

  const next: GoogleTokenCache = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || cached?.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  writeCache(next);
  return next.accessToken;
}
