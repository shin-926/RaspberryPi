// Custom Token ブリッジ＋Firestore REST 認証の smoke test。
// 初回はブリッジ（Henry idToken → CF → customToken → signIn）。
// 2回目以降はキャッシュ／refresh のみ。
// Firestore READ で idToken が discharge_summaries に対し受理されることを確認（本文は表示しない）。
import { getWebappsSession, webappsFirestoreFetch } from './webapps-auth.ts';

async function main(): Promise<void> {
  console.log('[verify-webapps-auth] セッション取得中（初回はブリッジ）...');
  const session = await getWebappsSession();
  console.log('[verify-webapps-auth] セッションOK:', {
    uid: session.uid,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });

  console.log('[verify-webapps-auth] Firestore READ で idToken 受理を確認...');
  const res = await webappsFirestoreFetch('discharge_summaries?pageSize=1', { method: 'GET' });
  console.log('[verify-webapps-auth] Firestore応答:', { ok: res.ok, status: res.status });
  if (!res.ok) {
    console.error('[verify-webapps-auth] 応答ボディ（先頭200）:', res.body.slice(0, 200));
    process.exit(1);
  }
  console.log('[verify-webapps-auth] OK: ブリッジ＋REST認証の全経路が動作。');
}

main().catch((e) => {
  console.error('[verify-webapps-auth] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
