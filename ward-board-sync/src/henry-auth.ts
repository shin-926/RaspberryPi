import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.ts';

interface TokenCache {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

let memoryCache: TokenCache | null = null;

function readCache(): TokenCache | null {
  if (memoryCache) return memoryCache;
  if (!existsSync(env.tokenCachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(env.tokenCachePath, 'utf8')) as TokenCache;
    memoryCache = data;
    return data;
  } catch {
    return null;
  }
}

function writeCache(cache: TokenCache): void {
  memoryCache = cache;
  mkdirSync(dirname(env.tokenCachePath), { recursive: true });
  writeFileSync(env.tokenCachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

async function refreshIdToken(refreshToken: string): Promise<TokenCache> {
  const url = `https://securetoken.googleapis.com/v1/token?key=${env.henryApiKey}`;
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json() as { id_token: string; refresh_token: string; expires_in: string };
  const expiresAt = Date.now() + parseInt(data.expires_in) * 1000;
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

export async function getHenryIdToken(): Promise<string> {
  const cached = readCache();
  // Use cached token if valid for at least 1 more minute
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.idToken;
  }

  const seedRefreshToken = cached?.refreshToken || env.henryRefreshToken;
  const fresh = await refreshIdToken(seedRefreshToken);
  writeCache(fresh);
  return fresh.idToken;
}
