// Phase E 検証（読み取りのみ）: 退院検知を実行し、生成対象を確認する。
// コンソールには件数のみ。対象患者リスト（氏名=PII）は gitignore 済みの _out/ に保存。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectTargets } from './detect.ts';
import { env } from './env.ts';

const WINDOW_DAYS = Number(process.argv[2] || 14);

function fmt(d: { year: number; month: number; day: number } | null): string {
  if (!d || !d.year) return '';
  return `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  console.log(`[verify-detect] 退院検知を実行します（直近${WINDOW_DAYS}日、読み取りのみ）...`);
  const result = await detectTargets(WINDOW_DAYS);

  console.log('[verify-detect] OK。件数（PIIは非表示）:');
  console.log({
    totalDischarged: result.totalDischarged,
    inWindowDays: WINDOW_DAYS,
    inWindow: result.inWindow,
    alreadyHasSummary: result.alreadyHasSummary,
    targetsToGenerate: result.targets.length,
  });

  const outDir = resolve(env.rootDir, '_out');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `detect-targets-${WINDOW_DAYS}d.md`);
  const lines = [
    `# 退院サマリー自動生成 対象患者（直近${WINDOW_DAYS}日・退院サマリ未作成）`,
    '',
    `対象: ${result.targets.length}名`,
    '',
    '| ID | 氏名 | 退院日 | 入院日 | 担当医 |',
    '|----|------|--------|--------|--------|',
    ...result.targets.map(
      (t) => `| ${t.serialNumber} | ${t.fullName} | ${fmt(t.dischargeDate)} | ${fmt(t.admissionDate)} | ${t.doctorName} |`,
    ),
  ];
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`[verify-detect] 対象リスト（PII）保存先: ${outPath}`);
  console.log('[verify-detect] ↑このファイルを開いて、自動生成してよい患者か確認してください。');
}

main().catch((e) => {
  console.error('[verify-detect] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
