import { fetchAllHospitalizedPatients } from './henry-graphql.ts';
import { syncWardPatients } from './firestore-sync.ts';
import { env } from './env.ts';

async function pingUptimeKuma(status: 'up' | 'down', msg: string, pingMs?: number): Promise<void> {
  if (!env.uptimeKumaPushUrl) return;
  const url = new URL(env.uptimeKumaPushUrl);
  url.searchParams.set('status', status);
  url.searchParams.set('msg', msg);
  if (pingMs !== undefined) url.searchParams.set('ping', String(pingMs));
  try {
    await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.warn('[ward-board-sync] Uptime Kuma ping failed:', e instanceof Error ? e.message : e);
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[ward-board-sync] Starting at ${startedAt.toISOString()}`);

  const patients = await fetchAllHospitalizedPatients();
  console.log(`[ward-board-sync] Fetched ${patients.length} hospitalized patients from Henry`);

  if (patients.length === 0) {
    console.warn('[ward-board-sync] No active patients returned. Skipping Firestore writes.');
    const elapsed = Date.now() - startedAt.getTime();
    await pingUptimeKuma('up', 'no active patients', elapsed);
    return;
  }

  const result = await syncWardPatients(patients);
  const elapsed = Date.now() - startedAt.getTime();
  console.log(`[ward-board-sync] Done: added=${result.added}, updated=${result.updated}, archived=${result.archived}, total=${result.total}`);
  console.log(`[ward-board-sync] Elapsed: ${elapsed}ms`);

  await pingUptimeKuma('up', `synced ${result.total} (${result.added}+/${result.updated}~/${result.archived}-)`, elapsed);
}

main().catch(async (err) => {
  console.error('[ward-board-sync] FATAL:', err);
  const errMsg = err instanceof Error ? err.message : String(err);
  await pingUptimeKuma('down', errMsg.slice(0, 200));
  process.exit(1);
});
