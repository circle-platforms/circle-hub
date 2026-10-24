// Case extraction and the projection: the case-review taking rule (tags or marks; case_rule narrows to tags and only
// counts marked-only nodes), the extraction of steps and expected results, and the projection's refusals with their
// fixes (contract and inventory refused whole with every problem).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCases } from './cases.ts';
import { projectItems } from './project.ts';
import { CONTRACT_DOC, PROFILE_DOC, AUTOID, MANIFEST_DOC, MINDMAP_MODEL } from './test-support.ts';

const SHA = 'f'.repeat(64);

function input(model: unknown, options: { contract?: unknown; manifest?: unknown; parameters?: unknown; external?: string | null; parser?: string | null } = {}): unknown {
  return {
    inputs: [
      { slot: 'subject', external: options.external ?? 'agile:mindmap:doc-1', sha256: SHA, parser: options.parser === undefined ? 'kityminder@1' : options.parser, model },
      { slot: 'contract', external: 'doc:doc:compile-contract', sha256: 'c'.repeat(64), parser: 'json@1', model: options.contract === undefined ? CONTRACT_DOC : options.contract },
      { slot: 'profile', model: PROFILE_DOC },
      { slot: 'inventory', external: 'doc:doc:bed-topology', sha256: 'd'.repeat(64), parser: 'json@1', model: options.manifest === undefined ? MANIFEST_DOC : options.manifest },
    ],
    parameters: options.parameters ?? { autoid: AUTOID },
    context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } },
  };
}

describe('取用例（和 case-review 同一规则）', () => {
  it('默认规则：带标签或带标记；步骤和期望结果照结构取出', () => {
    const extraction = extractCases(MINDMAP_MODEL, 'marked');
    assert.equal(extraction.cases.length, 2);
    const [tagged, marked] = extraction.cases;
    assert.equal(tagged.id, 'c-1');
    assert.deepEqual(tagged.tags, ['功能']);
    assert.deepEqual(tagged.steps, [{ text: '配置健康检查间隔 widget health interval 60', expected: ['健康检查间隔设置成功'] }]);
    assert.deepEqual(tagged.expected, []);
    assert.equal(marked.id, 'c-2');
    assert.deepEqual(marked.tags, []);
    assert.equal(extraction.markedOnly, 1);
    assert.equal(extraction.ruleSummary, '用例规则：标签或标记；其中 1 个只靠标记识别（没有标签）');
  });

  it('tagged 规则：只靠标记的节点不是用例，只计数', () => {
    const extraction = extractCases(MINDMAP_MODEL, 'tagged');
    assert.equal(extraction.cases.length, 1);
    assert.equal(extraction.cases[0].id, 'c-1');
    assert.equal(extraction.markedOnly, 0);
    assert.equal(extraction.candidates, 1);
    assert.equal(extraction.ruleSummary, '用例规则：只认标签；其中 0 个只靠标记识别（没有标签）');
  });
});

describe('投影', () => {
  it('每个用例一个条目，运行组里冻结合约、清单、租约视图和规则说明', () => {
    const out = projectItems(input(MINDMAP_MODEL)) as { items: Array<{ id: string; label: string; fields: Record<string, unknown>; location: { selector: string } }>; groups: Array<Record<string, unknown>>; warnings: Array<{ code: string }> };
    assert.deepEqual(
      out.items.map((item) => item.id),
      ['doc-1:c-1'],
    );
    assert.equal(out.items[0].label, '健康检查间隔配置测试');
    assert.equal(out.items[0].location.selector, 's/c-1');
    assert.deepEqual(out.items[0].fields.expected, []);
    assert.equal(out.items[0].fields.case_rule, 'marked');
    const group = out.groups[0];
    assert.equal(group.kind, 'case-compile');
    assert.equal((group.contract as Record<string, unknown>).schema, 'runtime-contract@2');
    assert.equal((group.manifest as Record<string, unknown>).schema, 'test-bed-manifest@1');
    assert.equal(group.rule_summary, '用例规则：标签或标记；其中 1 个只靠标记识别（没有标签）');
    assert.deepEqual(out.warnings, []);
  });

  it('tagged 参数：只靠标记的节点给警告，不投影', () => {
    const out = projectItems(input(MINDMAP_MODEL, { parameters: { case_rule: 'tagged', autoid: AUTOID } })) as { items: unknown[]; warnings: Array<{ code: string; message: string }> };
    assert.equal(out.items.length, 1);
    assert.deepEqual(out.warnings.map((w) => w.code), ['case-compile.candidate_only']);
  });

  it('拒绝：没有用例文档、不是脑图、没有合约、合约有问题、没有清单、清单有问题、参数无效', () => {
    const code = (out: unknown): string => (out as { error: { code: string } }).error.code;
    const withoutSubject = input(MINDMAP_MODEL) as { inputs: unknown[] };
    withoutSubject.inputs = withoutSubject.inputs.filter((slot) => (slot as { slot: string }).slot !== 'subject');
    assert.equal(code(projectItems(withoutSubject)), 'case-compile.no_subject');
    assert.equal(code(projectItems(input(MINDMAP_MODEL, { parser: 'json@1' }))), 'case-compile.subject_not_mindmap');
    const withoutContract = input(MINDMAP_MODEL) as { inputs: unknown[] };
    withoutContract.inputs = withoutContract.inputs.filter((slot) => (slot as { slot: string }).slot !== 'contract');
    assert.equal(code(projectItems(withoutContract)), 'case-compile.no_contract');
    const badContract = projectItems(input(MINDMAP_MODEL, { contract: { schema: 'compile-contract@1', objects: [] } })) as { error: { code: string; message: string }; warnings: Array<{ code: string; message: string }> };
    assert.equal(badContract.error.code, 'case-compile.contract_invalid');
    assert.match(badContract.error.message, /整份拒绝/);
    assert.ok(badContract.warnings.length > 0, '问题逐条变成警告');
    const withoutInventory = input(MINDMAP_MODEL) as { inputs: unknown[] };
    withoutInventory.inputs = withoutInventory.inputs.filter((slot) => (slot as { slot: string }).slot !== 'inventory');
    assert.equal(code(projectItems(withoutInventory)), 'case-compile.no_inventory');
    const badManifest = projectItems(input(MINDMAP_MODEL, { manifest: { schema: 'test-bed-manifest@1', beds: [{ name: 'bed-a', devices: [{ name: 'dut0', type: 'mystery', ipv4: [], ipv6: [] }] }] } })) as { error: { code: string }; warnings: Array<{ message: string }> };
    assert.equal(badManifest.error.code, 'case-compile.manifest_invalid');
    assert.match(badManifest.warnings.map((w) => w.message).join('\n'), /mystery/);
    assert.equal(code(projectItems(input(MINDMAP_MODEL, { parameters: { case_rule: 'strict' } }))), 'case-compile.invalid_parameter');
  });

  it('没有目标用例时拒绝启动而不是产生空计划', () => {
    const out = projectItems(input({ meta: {}, nodes: [{ text: '空文档', data: { id: 'empty' }, children: [] }] })) as { error: { code: string; fix: string } };
    assert.equal(out.error.code, 'case-compile.autoid_not_found'); assert.ok(out.error.fix);
  });
});
