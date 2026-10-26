import { recordRefusal, refusalSummary } from './lib/inject.ts';
// Writes a copy of a KityMinder export with known defects injected, and the gold that names them.
//   node scripts/real/inject-defects.ts --source <mindmap.json> --plan <plan.json> --out <dir> [--keep <n>]
// The plan is a JSON list of { label, seen_by, op } (scripts/real/lib/inject.ts); --keep cuts the copy after its n-th case so a
// review stays short. The copy and the gold hold real content: --out is a folder outside Git.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseNodes, firstCases, inject, type ManualFragment, type MindTree, type Planned } from './lib/inject.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main(): number {
  const [source, plan, out] = [arg('source'), arg('plan'), arg('out')];
  if (!source || !plan || !out) {
    console.error('用法：node scripts/real/inject-defects.ts --source <脑图 json> --plan <计划 json> --out <目录> [--keep <条数>] [--case-rule marked|tagged] [--manual <片段文件>]');
    return 2;
  }
  let tree = JSON.parse(readFileSync(source, 'utf8')) as MindTree;
  const keep = arg('keep');
  const caseRuleArg = arg('case-rule');
  if (caseRuleArg !== undefined && caseRuleArg !== 'marked' && caseRuleArg !== 'tagged') {
    console.error('--case-rule 只认 marked 或 tagged');
    return 2;
  }
  if (keep !== undefined) tree = firstCases(tree, Number(keep), { caseRule: caseRuleArg === 'tagged' ? 'tagged' : 'marked' });
  let manual: ManualFragment | undefined;
  const manualPath = arg('manual');
  if (manualPath !== undefined) {
    const bytes = readFileSync(manualPath);
    manual = { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const injected = inject(tree, JSON.parse(readFileSync(plan, 'utf8')) as Planned[], { caseRule: caseRuleArg, manual });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'mutated.json'), JSON.stringify(injected.tree));
  writeFileSync(join(out, 'gold.json'), `${JSON.stringify(injected.gold, null, 2)}\n`);
  console.log(`用例 ${caseNodes(injected.tree).length} 个，注入 ${injected.gold.length} 处缺陷；副本和标准答案写在 ${out}`);
  return 0;
}

if (import.meta.main) { try { process.exitCode = main(); } catch (error) { const diagnostic = recordRefusal(arg('out'), error); console.error('拒绝：' + refusalSummary(error) + (diagnostic ? '；私有诊断 ' + diagnostic : '；私有诊断未保存，改用 Git 外可写目录后重跑')); process.exitCode = 1; } }
