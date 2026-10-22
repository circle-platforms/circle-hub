// Writes a copy of a KityMinder export with known defects injected, and the gold that names them.
//   node scripts/real/inject-defects.ts --source <mindmap.json> --plan <plan.json> --out <dir> [--keep <n>]
// The plan is a JSON list of { label, seen_by, op } (scripts/real/lib/inject.ts); --keep cuts the copy after its n-th case so a
// review stays short. The copy and the gold hold real content: --out is a folder outside Git.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseNodes, firstCases, inject, type MindTree, type Planned } from './lib/inject.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main(): number {
  const [source, plan, out] = [arg('source'), arg('plan'), arg('out')];
  if (!source || !plan || !out) {
    console.error('用法：node scripts/real/inject-defects.ts --source <脑图 json> --plan <计划 json> --out <目录> [--keep <条数>]');
    return 2;
  }
  let tree = JSON.parse(readFileSync(source, 'utf8')) as MindTree;
  const keep = arg('keep');
  if (keep !== undefined) tree = firstCases(tree, Number(keep));
  const injected = inject(tree, JSON.parse(readFileSync(plan, 'utf8')) as Planned[]);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'mutated.json'), JSON.stringify(injected.tree));
  writeFileSync(join(out, 'gold.json'), `${JSON.stringify(injected.gold, null, 2)}\n`);
  console.log(`用例 ${caseNodes(injected.tree).length} 个，注入 ${injected.gold.length} 处缺陷；副本和标准答案写在 ${out}`);
  return 0;
}

process.exitCode = main();
