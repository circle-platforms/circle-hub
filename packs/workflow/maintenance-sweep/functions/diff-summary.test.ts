// 命令差总结：command_unchanged 检查先给出一条事实结论，按路径列出整个命令差（变更种类、前一构建用例数；新增的路径
// 不是维护项，注明不进范围），依据是影响视图。条目再多、被截掉多少，这条跨条目结论都排在条目前面看得到：合成 30 条
// 变更路径、2,000 个用例时列全 30 条，单条不超过 6,000 个字符；超过 200 条路径时写“另有 M 条”，完整的表在运行级
// 详情里（note.diff，整个命令差；note.details 仍只列维护路径的字段差异）。
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

/** 经投影和主体搭建走一遍，取 command_unchanged 的第一条结论（命令差总结）。 */
function summarize(model: unknown, parameters: unknown = {}): { summary: SummaryOutcome; outcomes: SummaryOutcome[]; projected: { [key: string]: unknown } } {
  const projected = projectItems(input(model, parameters)) as { items: unknown[]; groups: unknown[] };
  const subject = buildSubject({ items: projected.items, context: { groups: projected.groups } });
  const outcomes = checkOutcomes('command_unchanged', subject) as SummaryOutcome[];
  const summary = outcomes[0];
  assert.equal(summary.verdict, 'support', JSON.stringify(outcomes));
  assert.equal(summary.item, undefined, '命令差总结是跨条目结论');
  return { summary, outcomes, projected };
}

/** 合成 paths 条变更路径（新增、修改、删除轮着来），修改和删除的路径挂 pathCases 个前一构建用例。 */
function diffView(paths: number, pathCases: number) {
  const changes = [];
  let n = 0;
  for (let i = 0; i < paths; i++) {
    const change = i % 3 === 0 ? ('added' as const) : i % 3 === 1 ? ('modified' as const) : ('removed' as const);
    const path = `/commands/g${i % 5}/c${String(i).padStart(3, '0')}`;
    const from: CaseSpec[] = [];
    if (change !== 'added') {
      for (let k = 0; k < pathCases; k++) {
        n++;
        from.push({ document: `doc-${n}`, node: 'n1', title: `用例 ${n}`, priority: 1 });
      }
    }
    changes.push({
      path,
      change,
      before: change === 'added' ? [] : [{ name: `c${i}`, ...(change === 'modified' ? { help: '旧' } : {}) }],
      after: change === 'removed' ? [] : [{ name: `c${i}`, ...(change === 'modified' ? { help: '新' } : {}) }],
      from,
    });
  }
  return buildImpact(changes);
}

describe('命令差总结（跨条目结论）', () => {
  it('30 条变更路径、2,000 个前一构建用例：列全 30 条，单条在 6,000 个字符以内', () => {
    // 30 条路径：修改、删除各 10 条（各 67 个前一构建用例，共 2,010 个），新增 10 条。
    const { summary } = summarize(diffView(30, 67));
    assert.ok(summary.statement.startsWith('命令差共 30 条（路径、变更种类、前一构建用例数）：'), summary.statement.slice(0, 120));
    const lines = summary.statement.split('\n').slice(1);
    assert.equal(lines.length, 30, '每条路径一行');
    for (let i = 0; i < 30; i++) {
      const path = `/commands/g${i % 5}/c${String(i).padStart(3, '0')}`;
      const found = lines.filter((line) => line.includes(path));
      assert.equal(found.length, 1, `路径 ${path} 恰好一行`);
      const change = i % 3 === 0 ? '新增' : i % 3 === 1 ? '修改' : '删除';
      if (change === '新增') assert.equal(found[0], `- ${path} 新增，前一构建 0 条用例（不进范围）`);
      else assert.equal(found[0], `- ${path} ${change}，前一构建 67 条用例`);
    }
    assert.ok(summary.statement.length <= 6000, `单条 ${summary.statement.length} 个字符，超过 6,000`);
    assert.deepEqual(summary.grounds, [VIEW_SRC], '依据是影响视图');
    assert.deepEqual(summary.data, { changed_paths: 30, listed: 30 });
  });

  it('没有字段差异的修改路径也在命令差里（不是维护项，但不隐去）', () => {
    const view = buildImpact([{ path: '/commands/same', change: 'modified', before: [{ name: 'same', help: '相同' }], after: [{ name: 'same', help: '相同' }] }]);
    const { summary } = summarize(view);
    assert.ok(summary.statement.includes('- /commands/same 修改，前一构建 0 条用例'), summary.statement);
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
    const view = buildImpact([{ path: '/commands/drop', change: 'removed', before: [{ name: 'drop' }], from: [{ document: 'doc-1', node: 'n1', title: '删除上的用例', priority: 1 }] }], { truncated: true, changedPaths: 80 });
    const { summary } = summarize(view);
    assert.ok(summary.statement.startsWith('命令差共 80 条（影响视图被截断，这 1 条是列出的部分；'), summary.statement);
    assert.deepEqual(summary.data, { changed_paths: 80, listed: 1 });
  });
});
