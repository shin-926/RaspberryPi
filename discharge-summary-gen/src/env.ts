import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(): void {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const henryGraphqlEndpoint = process.env.HENRY_GRAPHQL_ENDPOINT || 'https://henry-app.jp/graphql';

export const env = {
  henryApiKey: required('HENRY_FIREBASE_API_KEY'),
  henryRefreshToken: required('HENRY_FIREBASE_REFRESH_TOKEN'),
  henryOrgUuid: required('HENRY_ORG_UUID'),
  henryGraphqlEndpoint,
  henryGraphqlV2Endpoint: henryGraphqlEndpoint.replace(/\/graphql$/, '/graphql-v2'),
  firebaseProjectId: required('FIREBASE_PROJECT_ID'),
  tokenCachePath: resolve(ROOT, process.env.TOKEN_CACHE_PATH || './.secrets/token-cache.json'),
  uptimeKumaPushUrl: process.env.UPTIME_KUMA_PUSH_URL || '',
  // Google OAuth（拡張の既存クライアントを流用。client_id は公開値、client_secret は .env で渡す）
  googleClientId: process.env.GOOGLE_CLIENT_ID || '106000879248-q6ojmt4amma3dd5sdltdl75765jnls7d.apps.googleusercontent.com',
  googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  // 退院サマリーDocs生成に必須。chrome.storage.local['google_drive_tokens'].refresh_token を .env に設定する。
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
  googleTokenCachePath: resolve(ROOT, process.env.GOOGLE_TOKEN_CACHE_PATH || './.secrets/google-token-cache.json'),
  rootDir: ROOT,
};
