// Google OAuth: 拡張の refresh_token を流用してサーバー側でアクセストークンを更新する。
// henry_google_auth.ts の directRefreshToken（oauth2.googleapis.com/token）と同等の素のHTTP。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.ts';

interface GoogleTokenCache {
  accessToken: string;
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

  if (!env.googleRefreshToken) {
    throw new Error('GOOGLE_REFRESH_TOKEN が未設定です。.env に chrome.storage.local の refresh_token を設定してください。');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: env.googleRefreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const detail = [data.error, data.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
    throw new Error(`Google token refresh failed: ${detail}`);
  }
  const fresh: GoogleTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  writeCache(fresh);
  return fresh.accessToken;
}
