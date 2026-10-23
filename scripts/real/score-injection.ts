import { dirname } from 'node:path';
import { recordRefusal, refusalSummary } from './lib/inject.ts';
// Scores a review of an injected copy against the gold (task gold-review step 3).
//   node bin/circle-hub run show <run> --json > run.json
//   node scripts/real/score-injection.ts --gold <gold.json> --run <run.json> [--baseline <run.json of the untouched document>]
//     [--verify <verify run.json>] [--copy <mutated.json>] [--details <file>]
// The screen shows counts only; the per-node detail (ids, tags and codes) goes to --details.
import { readFileSync, writeFileSync } from 'node:fs';
import type { GoldEntry } from './lib/inject.ts';
import { detail, render, score, type ResultLike } from './lib/score.ts';
import { literalGold } from './gold/literal.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const resultOf = (file: string): ResultLike => (JSON.parse(readFileSync(file, 'utf8')) as { latest: { result: ResultLike } }).latest.result;

function main(): number {
  const [gold, run] = [arg('gold'), arg('run')];
  if (!gold || !run) {
    console.error('用法：node scripts/real/score-injection.ts --gold <标准答案 json> --run <run show --json 的输出> [--baseline <没改过的评审>] [--verify <复核>] [--copy <副本>] [--details <文件>]');
    return 2;
  }
  const baseline = arg('baseline');
  const verify = arg('verify');
  const copy = arg('copy');
  const details = arg('details');
  const literal = copy === undefined ? undefined : literalGold(JSON.parse(readFileSync(copy, 'utf8')));
  const scored = score(JSON.parse(readFileSync(gold, 'utf8')) as GoldEntry[], resultOf(run), {
    ...(baseline === undefined ? {} : { baseline: resultOf(baseline) }),
    ...(verify === undefined ? {} : { verify: resultOf(verify) }),
    ...(literal === undefined ? {} : { literal }),
  });
  console.log(render(scored).join('\n'));
  if (details !== undefined) writeFileSync(details, detail(scored));
  return scored.detections.every((d) => d.detected) ? 0 : 1;
}

if (import.meta.main) { try { process.exitCode = main(); } catch (error) { recordRefusal(arg('details') ? dirname(arg('details')!) : arg('gold') ? dirname(arg('gold')!) : undefined, error); console.error('拒绝：' + refusalSummary(error)); process.exitCode = 1; } }
