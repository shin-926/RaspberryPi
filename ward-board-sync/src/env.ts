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

export const env = {
  henryApiKey: required('HENRY_FIREBASE_API_KEY'),
  henryRefreshToken: required('HENRY_FIREBASE_REFRESH_TOKEN'),
  henryOrgUuid: required('HENRY_ORG_UUID'),
  henryGraphqlEndpoint: process.env.HENRY_GRAPHQL_ENDPOINT || 'https://henry-app.jp/graphql',
  firebaseProjectId: required('FIREBASE_PROJECT_ID'),
  tokenCachePath: resolve(ROOT, process.env.TOKEN_CACHE_PATH || './.secrets/token-cache.json'),
  uptimeKumaPushUrl: process.env.UPTIME_KUMA_PUSH_URL || '',
  rootDir: ROOT,
};
