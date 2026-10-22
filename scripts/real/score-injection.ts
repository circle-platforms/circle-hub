// Scores a review of an injected copy against the gold.
//   node bin/circle-hub run show <run> --json > run.json
//   node scripts/real/score-injection.ts --gold <gold.json> --run <run.json> [--baseline <run.json of the untouched document>]
import { readFileSync } from 'node:fs';
import type { GoldEntry } from './lib/inject.ts';
import { render, score, type ResultLike } from './lib/score.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const resultOf = (file: string): ResultLike => (JSON.parse(readFileSync(file, 'utf8')) as { latest: { result: ResultLike } }).latest.result;

function main(): number {
  const [gold, run] = [arg('gold'), arg('run')];
  if (!gold || !run) {
    console.error('用法：node scripts/real/score-injection.ts --gold <标准答案 json> --run <run show --json 的输出> [--baseline <没改过的评审>]');
    return 2;
  }
  const baseline = arg('baseline');
  const scored = score(JSON.parse(readFileSync(gold, 'utf8')) as GoldEntry[], resultOf(run), baseline === undefined ? undefined : resultOf(baseline));
  console.log(render(scored).join('\n'));
  return scored.detections.every((d) => d.detected) ? 0 : 1;
}

process.exitCode = main();
