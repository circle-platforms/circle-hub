import {nativeStep,indexedStructure} from './testing/structure.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoundInput, RunContext } from '../../../contracts/src/pack.ts';
import type { IndexView, ViewEntry } from '../../../contracts/src/views.ts';
import { checkDuplicate } from './functions/checks.ts';
import { projectDefects } from './functions/projection.ts';
import { SYNTHETIC_BOUND_MANUAL, SYNTHETIC_BUG_74001, SYNTHETIC_CATALOG, makeGoodDraft } from './testing/fixtures.ts';

const DUMMY_CONTEXT: RunContext = {
  product: 'famx',
  names: ['FAMX', 'FAMY'],
  line: '10.6.1',
  build: 'Rel_FAMX_10_6_1_57',
  root: '1111111111111111111111111111111111111111111111111111111111111111',
  parameters: {},
  groups: [],
};

function makeBoundDefect(bug = SYNTHETIC_BUG_74001): BoundInput {
  return {
    slot: 'defects',
    external: `plm:bug:${bug.id}`,
    sha256: 'sha_bug_74001',
    media_type: 'application/json',
    parser: 'json@1',
    model: bug,
    meta: { title: `缺陷 ${bug.id}`, status: 'Fixed' },
  };
}

describe('compact case index and deduplication at real scale', () => {
  it('projects 100,000 indexed cases within 4 MiB output and 256 MB memory', () => {
    // Generate 100,000 synthetic indexed cases across 2,000 distinct command sets
    const entries: Record<string, ViewEntry> = {};
    const keys: Record<string, string[]> = {};
    const TOTAL_CASES = 100_000;
    const NUM_COMMAND_KEYS = 2_000;

    for (let k = 0; k < NUM_COMMAND_KEYS; k++) {
      keys[`cmd_${k}`] = [];
    }

    for (let i = 0; i < TOTAL_CASES; i++) {
      const digest = i.toString(16).padStart(64, '0');
      const cmdKey = `service port ${i % NUM_COMMAND_KEYS}`;
      entries[digest] = {
        entry: digest,
        kind: 'case',
        statement: `doc_${i % 100}:node_${i} | 验证端口配置 ${i}`,
        reference: `tree:1111111111111111111111111111111111111111111111111111111111111111/commands/service/port@${digest}`,
        data: {
          document: `doc_${i % 100}.km.json`,
          node: `node_${i}`,
          title: `验证端口配置详情说明项编号 ${i} 涵盖基础业务流与高可用校验`,
          negative: false,
          commands: [cmdKey],
        },
      };
      if (keys[cmdKey]) keys[cmdKey].push(digest);
      else keys[cmdKey] = [digest];
    }

    const largeIndexView: IndexView = {
      schema: 'index-view@1',
      product: 'famx',
      build: { build: 'Rel_FAMX_10_6_1_57', root: '1111111111111111111111111111111111111111111111111111111111111111' },
      kind: 'case',
      key: 'commands',
      keys,
      entries,
      total_keys: Object.keys(keys).length,
      total_entries: TOTAL_CASES,
      truncated: false,
      skipped: 0,
      notes: [],
    };

    const boundIndex: BoundInput = {
      slot: 'indexed_cases',
      external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=document,node,title',
      sha256: 'sha_large_index',
      media_type: 'application/json',
      parser: 'json@1',
      model: largeIndexView,
      meta: null,
    };

    const initialMem = process.memoryUsage().heapUsed;
    const start = Date.now();
    const result = projectDefects({
      inputs: [SYNTHETIC_BOUND_MANUAL, makeBoundDefect(), boundIndex],
      parameters: {},
      context: DUMMY_CONTEXT,
    });
    const elapsed = Date.now() - start;
    const currentMem = process.memoryUsage().heapUsed;

    assert.ok(!('error' in result), 'projection of 100,000 cases must succeed');
    assert.ok(result.groups && result.groups.length > 0, 'groups must contain compact index');

    const compact = (result.groups[0] as { indexed_cases: Record<string, unknown> }).indexed_cases;
    assert.equal(compact.schema, 'compact-case-index@1');
    assert.equal(compact.total, TOTAL_CASES);
    assert.equal(compact.complete, false, '100,000 cases must be truncated to fit 4 MiB budget');
    assert.ok(typeof compact.dropped === 'number' && compact.dropped > 0, 'dropped cases must be positive');

    // Assert output size is strictly <= 4 MiB (4,194,304 bytes)
    const serialized = JSON.stringify(result);
    const outputBytes = Buffer.byteLength(serialized, 'utf8');
    assert.ok(
      outputBytes <= 4 * 1024 * 1024,
      `projection output (${outputBytes} bytes) must not exceed 4 MiB (4,194,304 bytes)`,
    );

    // Assert memory heap growth during projection is reasonable (< 256 MB)
    const heapDiffMb = (currentMem - initialMem) / (1024 * 1024);
    assert.ok(heapDiffMb < 256, `heap growth ${heapDiffMb.toFixed(2)} MB must be < 256 MB`);
    assert.ok(elapsed < 10000, `projection execution ${elapsed} ms must be within reasonable time`);
  });

  it('reports unknown with dropped count when no duplicate found in truncated index, but still refutes if duplicate found', () => {
    // Construct a compact index that was truncated
    const retainedItem = {
      document: 'retained_doc.km.json',
      node: 'node_10',
      title: '健康检查保留项',
      reference: 'tree:1111111111111111111111111111111111111111111111111111111111111111/commands/show/health@2222',
      negative: false,
      case_structure: {...indexedStructure,commands:[nativeStep('show health').identity],expected:makeGoodDraft().expected.map(e=>({after:e.after,quote:e.identity}))},
    };

    const truncatedIndex = {
      schema: 'compact-case-index@1' as const,
      by_commands: {
        'show health': [retainedItem],
      },
      total: 50000,
      dropped: 48000,
      complete: false,
      unplaced: 0,
      notes: ['紧凑索引超出大小上限，按键顺序截断并丢弃 48000 个用例'],
    };

    // Case A: Draft resolves to a head that is not in the truncated index -> must return unknown stating dropped count
    const nonMatchingDraft = makeGoodDraft();
    nonMatchingDraft.steps = [nativeStep('widget health interval 60')];
    nonMatchingDraft.title = '全然不同的用例';

    const unknownOutcome = checkDuplicate({
      item: '74001',
      drafts: [nonMatchingDraft],
      indexed_cases: truncatedIndex,
      catalog: SYNTHETIC_CATALOG,
    });
    assert.equal(unknownOutcome.length, 1);
    assert.equal(unknownOutcome[0].verdict, 'unknown');
    assert.equal(unknownOutcome[0].reason, 'integrity_unproven');
    assert.ok(
      unknownOutcome[0].statement.includes('48000'),
      `unknown statement "${unknownOutcome[0].statement}" must state dropped count`,
    );

    // Case B: Draft DOES match a retained entry -> must still return refute (advisory duplicate)
    const duplicateDraft = makeGoodDraft();
    duplicateDraft.steps = [nativeStep('show health')];
    duplicateDraft.title = '健康检查保留项';
    duplicateDraft.negative = false;

    const refuteOutcome = checkDuplicate({
      item: '74001',
      drafts: [duplicateDraft],
      indexed_cases: truncatedIndex,
      catalog: SYNTHETIC_CATALOG,
    });
    assert.equal(refuteOutcome.length, 1);
    assert.equal(refuteOutcome[0].verdict, 'refute');
    assert.equal(refuteOutcome[0].code, 'defect-to-case.duplicate_case');
    assert.equal(refuteOutcome[0].tier, 'advisory');
    assert.ok(refuteOutcome[0].statement.includes('node_10'));
  });

  it('counts cases without commands as unplaced and excludes them from deduplication', () => {
    const viewWithUnplaced: IndexView = {
      schema: 'index-view@1',
      product: 'famx',
      build: { build: 'Rel_FAMX_10_6_1_57', root: '1111111111111111111111111111111111111111111111111111111111111111' },
      kind: 'case',
      key: 'commands',
      keys: {
        'show health': ['1111111111111111111111111111111111111111111111111111111111111111'],
      },
      entries: {
        '1111111111111111111111111111111111111111111111111111111111111111': {
          entry: '1111111111111111111111111111111111111111111111111111111111111111',
          kind: 'case',
          statement: 'doc:n1 | 有命令的用例',
          reference: 'tree:root/commands/show/health@1111',
          data: {
            document: 'doc.km.json',
            node: 'n1',
            title: '有命令的用例',
            commands: ['show health'],
          },
        },
        '2222222222222222222222222222222222222222222222222222222222222222': {
          entry: '2222222222222222222222222222222222222222222222222222222222222222',
          kind: 'case',
          statement: 'doc:n2 | 无命令的未归位用例',
          reference: 'tree:root/unplaced@2222',
          data: {
            document: 'doc.km.json',
            node: 'n2',
            title: '无命令的未归位用例',
            commands: [], // no commands
          },
        },
        '3333333333333333333333333333333333333333333333333333333333333333': {
          entry: '3333333333333333333333333333333333333333333333333333333333333333',
          kind: 'case',
          statement: 'doc:n3 | 第二个无命令用例',
          reference: 'tree:root/unplaced@3333',
          data: {
            document: 'doc.km.json',
            node: 'n3',
            title: '第二个无命令用例',
          },
        },
      },
      total_keys: 1,
      total_entries: 3,
      truncated: false,
      skipped: 0,
      notes: [],
    };

    const boundIndex: BoundInput = {
      slot: 'indexed_cases',
      external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=document,node,title',
      sha256: 'sha_index_unplaced',
      media_type: 'application/json',
      parser: 'json@1',
      model: viewWithUnplaced,
      meta: null,
    };

    const result = projectDefects({
      inputs: [SYNTHETIC_BOUND_MANUAL, makeBoundDefect(), boundIndex],
      parameters: {},
      context: DUMMY_CONTEXT,
    });

    assert.ok(!('error' in result));
    const compact = (result.groups![0] as { indexed_cases: Record<string, unknown> }).indexed_cases;
    assert.equal(compact.total, 1, 'only 1 case has commands');
    // commands: [] is genuinely command-less (unplaced); a missing commands field is an unknown set, counted apart.
    assert.equal(compact.unplaced, 1, '1 case has an empty command list');
    assert.equal(compact.unplacedCommands, 1, '1 case has no commands field (unknown set)');
    assert.ok(
      (compact.notes as string[]).some((n) => n.includes('1') && (n.includes('没有命令') || n.includes('未归位'))),
      'notes must mention the unplaced case',
    );
    assert.ok(
      (compact.notes as string[]).some((n) => n.includes('commands 字段')),
      'notes must mention the entry without a commands field',
    );

    // A draft matching the unplaced case must NOT be refuted because unplaced cases do not participate in deduplication
    const draftMatchingUnplaced = makeGoodDraft();
    draftMatchingUnplaced.steps = [nativeStep('widget health interval 60')];
    draftMatchingUnplaced.title = '无命令的未归位用例';

    const outcome = checkDuplicate({
      item: '74001',
      drafts: [draftMatchingUnplaced],
      indexed_cases: compact,
      catalog: SYNTHETIC_CATALOG,
    });
    // An entry without a commands field keeps "no duplicate" unknown (its set is unknown, not empty); the empty-list
    // one never triggers a refutation on its own.
    assert.equal(outcome[0].verdict, 'unknown', 'a missing commands field keeps the no-duplicate claim unknown');
    assert.ok(outcome[0].statement.includes('commands 字段'));
  });
});
