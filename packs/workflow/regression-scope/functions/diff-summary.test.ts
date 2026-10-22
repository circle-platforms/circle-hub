// 命令差总结：uncovered_changes 检查先给出一条事实结论，按路径列出整个命令差（变更种类、后一构建用例数；删除的路径
// 注明不进范围），依据是影响视图。条目再多、被截掉多少，这条跨条目结论都排在条目前面看得到：合成 30 条变更路径、
// 2,000 个用例时列全 30 条，单条不超过 6,000 个字符；超过 200 条路径时写“另有 M 条”，完整的表在运行级详情里。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutcomes } from './check.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { buildImpact, SOURCE, type CaseSpec } from './test-support.ts';

const VIEW_SRC = `src:${SOURCE}`;

const input = (model: unknown, parameters: unknown = {}): unknown => ({
  inputs: [{ slot: 'impact', external: null, sha256: SOURCE, media_type: 'application/json', parser: 'json@1', model, meta: null }],
  parameters,
  context: {},
});

interface SummaryOutcome {
  verdict: string;
  item?: string;
  statement: string;
  grounds: string[];
  data?: { [key: string]: unknown };
}

/** 经投影和主体搭建走一遍，取 uncovered_changes 的第一条结论（命令差总结）。 */
function summarize(model: unknown, parameters: unknown = {}): { summary: SummaryOutcome; outcomes: SummaryOutcome[]; projected: { [key: string]: unknown } } {
  const projected = projectItems(input(model, parameters)) as { items: unknown[]; groups: unknown[] };
  const subject = buildSubject({ items: projected.items, context: { groups: projected.groups } });
  const outcomes = checkOutcomes('uncovered_changes', subject) as SummaryOutcome[];
  const summary = outcomes[0];
  assert.equal(summary.verdict, 'support', JSON.stringify(outcomes));
  assert.equal(summary.item, undefined, '命令差总结是跨条目结论');
  return { summary, outcomes, projected };
}

/** 合成 paths 条变更路径（新增、修改、删除轮着来），每条未被删除的路径挂 pathCases 个后一构建用例。 */
function diffView(paths: number, pathCases: number, priorityOf: (n: number) => number = () => 1) {
  const changes = [];
  let n = 0;
  for (let i = 0; i < paths; i++) {
    const change = i % 3 === 0 ? ('added' as const) : i % 3 === 1 ? ('modified' as const) : ('removed' as const);
    const path = `/commands/g${i % 5}/c${String(i).padStart(3, '0')}`;
    const to: CaseSpec[] = [];
    if (change !== 'removed') {
      for (let k = 0; k < pathCases; k++) {
        n++;
        to.push({ document: `doc-${n}`, node: 'n1', title: `用例 ${n}`, priority: priorityOf(n) });
      }
    }
    changes.push({ path, change, before: change === 'added' ? [] : [{ name: `c${i}` }], after: change === 'removed' ? [] : [{ name: `c${i}` }], to });
  }
  return buildImpact(changes);
}

describe('命令差总结（跨条目结论）', () => {
  it('30 条变更路径、2,000 个用例：列全 30 条，单条在 6,000 个字符以内', () => {
    // 30 条路径：新增、修改各 10 条（各 67 个用例，共 2,010 个），删除 10 条。
    const { summary } = summarize(diffView(30, 67));
    assert.ok(summary.statement.startsWith('命令差共 30 条（路径、变更种类、后一构建用例数）：'), summary.statement.slice(0, 120));
    const lines = summary.statement.split('\n').slice(1);
    assert.equal(lines.length, 30, '每条路径一行');
    for (let i = 0; i < 30; i++) {
      const path = `/commands/g${i % 5}/c${String(i).padStart(3, '0')}`;
      const found = lines.filter((line) => line.includes(path));
      assert.equal(found.length, 1, `路径 ${path} 恰好一行`);
      const change = i % 3 === 0 ? '新增' : i % 3 === 1 ? '修改' : '删除';
      if (change === '删除') assert.equal(found[0], `- ${path} 删除，后一构建 0 条用例（不进范围）`);
      else assert.equal(found[0], `- ${path} ${change}，后一构建 67 条用例`);
    }
    assert.ok(summary.statement.length <= 6000, `单条 ${summary.statement.length} 个字符，超过 6,000`);
    assert.deepEqual(summary.grounds, [VIEW_SRC], '依据是影响视图');
    assert.deepEqual(summary.data, { changed_paths: 30, listed: 30 });
  });

  it('用例数取自运行级详情，不受优先级筛选影响', () => {
    // 只有一半用例是优先级 1，筛选后条目减半，总结里的用例数照旧。
    const { summary, projected } = summarize(diffView(3, 4, (n) => (n % 2 === 0 ? 1 : 2)), { priorities: [1] });
    const items = projected.items as unknown[];
    assert.equal(items.length, 4, '筛选后只剩优先级 1 的用例');
    assert.ok(summary.statement.includes('- /commands/g0/c000 新增，后一构建 4 条用例'), summary.statement);
    assert.ok(summary.statement.includes('- /commands/g1/c001 修改，后一构建 4 条用例'), summary.statement);
  });

  it('include_added 为 false 时新增路径也注明不进范围，用例数照写', () => {
    const { summary } = summarize(diffView(2, 3), { include_added: false });
    assert.ok(summary.statement.includes('- /commands/g0/c000 新增，后一构建 3 条用例（不进范围）'), summary.statement);
    assert.ok(summary.statement.includes('- /commands/g1/c001 修改，后一构建 3 条用例'), summary.statement);
  });

  it('超过 200 条路径：写前 200 行和“另有 M 条”，合计照写', () => {
    const { summary } = summarize(diffView(210, 1));
    assert.ok(summary.statement.startsWith('命令差共 210 条'), summary.statement.slice(0, 60));
    const lines = summary.statement.split('\n').slice(1);
    assert.equal(lines.length, 201);
    assert.equal(lines[200], '- 另有 10 条，完整的表在运行级详情里');
    assert.deepEqual(summary.data, { changed_paths: 210, listed: 200 });
  });

  it('没有变更路径：命令差为 0 条', () => {
    const { summary } = summarize(buildImpact([]));
    assert.equal(summary.statement, '命令差共 0 条：两个构建的命令定义没有差异。');
    assert.deepEqual(summary.data, { changed_paths: 0, listed: 0 });
  });

  it('影响视图被截断：合计写全部，说明列出的只是一部分', () => {
    const view = buildImpact([{ path: '/commands/show', change: 'modified', to: [{ document: 'doc-1', node: 'n1', title: '查看', priority: 1 }] }], { truncated: true, changedPaths: 80 });
    const { summary } = summarize(view);
    assert.ok(summary.statement.startsWith('命令差共 80 条（影响视图被截断，这 1 条是列出的部分；'), summary.statement);
    assert.deepEqual(summary.data, { changed_paths: 80, listed: 1 });
  });
});
