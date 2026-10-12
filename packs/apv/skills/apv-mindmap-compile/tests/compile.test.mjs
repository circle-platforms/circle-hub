import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prep } from '../scripts/prep.mjs';
import { checkRecompose } from '../scripts/check-recompose.mjs';
import { gateBatch, gateCase, destructivePatterns } from '../scripts/gate.mjs';
import { emitBatch, readBack, HEADERS } from '../scripts/emit.mjs';
import { readXlsx } from '../scripts/xlsx.mjs';
import { sha256, writeJson } from '../scripts/lib.mjs';

const fixture = readFileSync(new URL('./fixtures/mindmap.json', import.meta.url));
const BUILD = 'Rel_SYN_9_9_0_42';
const batchDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'apv-compile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('prep keeps the source rules: one root, 18-digit autoids kept exact, two layouts, skipped and unbound cases', () => {
  const manifest = prep(fixture, 'mindmap.json');
  assert.equal(manifest.case_count, 4, 'the case marked auto=NO is left out');
  assert.equal(manifest.source_sha256, sha256(fixture));
  const [first, second, , fifth] = manifest.cases;
  assert.equal(second.autoid, '100000000000000002', 'an autoid written as a number keeps all 18 digits');
  assert.equal(first.source_layout, 'title_steps_expectations');
  assert.deepEqual(first.group_path, ['LBX 合成会话验证', '会话超时']);
  assert.deepEqual(first.step_intents, [{ desc: '查看会话超时配置', expected: '显示 timeout 90' }]);
  assert.equal(second.source_layout, 'case_body_with_leaf_expectation');
  assert.deepEqual(second.step_intents, [
    { desc: '1. 配置会话超时为 120 [check1]', expected: '[check1] 配置成功' },
    { desc: '2. 查看会话超时配置 [check2]', expected: '[check2] 显示 timeout 120' },
  ]);
  assert.deepEqual(second.unbound_expectations, ['[check3] 不出现错误提示']);
  assert.equal(fifth.autoid, '100000000000000005');
  // A UTF-8 marker in front is ignored, but the hash is of the bytes as given.
  const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture]);
  assert.equal(prep(marked, 'x').case_count, 4);
  assert.equal(prep(marked, 'x').source_sha256, sha256(marked));
  const refuse = (value, code) =>
    assert.throws(() => prep(Buffer.from(JSON.stringify(value)), 'x'), (error) => error.code === code);
  refuse([{ data: {}, children: [] }, { data: {}, children: [] }], 'mindmap_parse_failed');
  refuse({ data: {}, children: [] }, 'mindmap_parse_failed');
  refuse([{ data: { text: 'r' }, children: [] }], 'no_case_node');
  refuse([{ data: { text: 'r' }, children: [{ data: { text: 'c', autoid: '12345' } }] }], 'invalid_autoid');
  refuse(
    [{ data: { text: 'r' }, children: [{ data: { text: 'a', autoid: '1'.repeat(18) } }, { data: { text: 'b', autoid: '1'.repeat(18) } }] }],
    'duplicate_autoid',
  );
});

// What a model would write for the fixture: three cases authored, one true gap.
function machineFor(manifest) {
  return {
    schema: 'apv.mindmap-compile.machine',
    source_sha256: manifest.source_sha256,
    build: BUILD,
    cases: [
      {
        autoid: '100000000000000001',
        bucket: 'exp_recipe',
        contract: { intent: '默认会话超时为 90 秒', verification_method: '查看会话超时配置', expectation: '显示 timeout 90' },
        origin: { intent: 'title', verification_method: 'step:1', expectation: 'expectation:1' },
        expectations: [{ n: 1, text: '显示 timeout 90', origin: 'expectation:1' }],
      },
      {
        autoid: '100000000000000002',
        bucket: 'step_recipe',
        contract: { intent: '配置会话超时为 120 [check1]', verification_method: '查看会话超时配置 [check2]', expectation: '显示 timeout 120' },
        origin: { intent: 'step:1', verification_method: 'step:2', expectation: 'expectation:check2' },
        expectations: [
          { n: 1, text: '配置成功', origin: 'expectation:check1' },
          { n: 2, text: '显示 timeout 120', origin: 'expectation:check2' },
        ],
      },
      { autoid: '100000000000000004', bucket: 'true_gap', proposal: ['没有写怎样判断间隔已生效'] },
      {
        autoid: '100000000000000005',
        bucket: 'exp_recipe',
        contract: { intent: '启用会话镜像', verification_method: '启用会话镜像', expectation: '显示 mirror on' },
        origin: { intent: 'title', verification_method: 'step:1', expectation: 'expectation:1' },
        expectations: [{ n: 1, text: '显示 mirror on', origin: 'expectation:1' }],
      },
    ],
  };
}
const hit = (command) => ({ command, build: BUILD, status: 'hit', head: command.split(' ').slice(0, 3).join(' '), violations: [], evidenceId: 'evd_1' });
function casesFor(manifest) {
  const group = (id) => manifest.cases.find((c) => c.autoid === id).group_path;
  return {
    '100000000000000001': {
      schema: 'apv.mechanical-case',
      autoid: '100000000000000001',
      description: { intent_verbatim: '默认会话超时为 90 秒', group_path: group('100000000000000001') },
      build: BUILD,
      init_commands: [],
      blocks: [
        { kind: 'OBSERVE_ASSERT', host: 'APV_0', cmd: 'show slb session timeout', desc: '查看会话超时配置',
          asserts: [{ op: 'found', pattern: 'timeout\\s+90', expectation_id: 'u1:100000000000000001:1:0', desc: '显示 timeout 90' }] },
      ],
      expectation_binding: [{ expectation_id: 'u1:100000000000000001:1:0', claim_kind: 'Author', block_index: 0, assert_index: 0 }],
      escape_hatches: [],
      command_receipts: [hit('show slb session timeout')],
    },
    '100000000000000002': {
      schema: 'apv.mechanical-case',
      autoid: '100000000000000002',
      description: { intent_verbatim: '配置会话超时为 120 [check1]', group_path: group('100000000000000002') },
      build: BUILD,
      init_commands: ['slb session clear statistics'],
      blocks: [
        { kind: 'CONFIG', host: 'APV_0', cmds: ['slb session timeout 120'], desc: '配置会话超时为 120' },
        { kind: 'OBSERVE_ASSERT', host: 'APV_0', cmd: 'show slb session timeout', desc: '查看会话超时配置',
          asserts: [
            { op: 'not_found', pattern: '[Ee]rror', expectation_id: 'u1:100000000000000002:1:0' },
            { op: 'found', pattern: 'timeout\\s+120', expectation_id: 'u1:100000000000000002:2:0' },
          ] },
        { kind: 'SLEEP', seconds: 2 },
        { kind: 'CONFIG', host: 'APV_0', cmds: ['no slb session timeout'], desc: '恢复默认' },
      ],
      expectation_binding: [
        { expectation_id: 'u1:100000000000000002:1:0', claim_kind: 'Author', block_index: 1, assert_index: 0 },
        { expectation_id: 'u1:100000000000000002:2:0', claim_kind: 'Author', block_index: 1, assert_index: 1 },
      ],
      escape_hatches: [],
      command_receipts: ['slb session clear statistics', 'slb session timeout 120', 'show slb session timeout', 'no slb session timeout'].map(hit),
    },
    '100000000000000005': {
      schema: 'apv.mechanical-case',
      autoid: '100000000000000005',
      description: { intent_verbatim: '启用会话镜像', group_path: group('100000000000000005') },
      build: BUILD,
      init_commands: [],
      blocks: [
        { kind: 'CONFIG', host: 'APV_0', cmds: ['slb session mirror on'], desc: '启用会话镜像' },
        { kind: 'OBSERVE_ASSERT', host: 'APV_0', cmd: 'show slb session mirror',
          asserts: [{ op: 'abs_found', pattern: 'mirror on', expectation_id: 'u1:100000000000000005:1:0' }] },
      ],
      expectation_binding: [{ expectation_id: 'u1:100000000000000005:1:0', claim_kind: 'Author', block_index: 1, assert_index: 0 }],
      escape_hatches: [],
      command_receipts: [
        { command: 'slb session mirror on', build: BUILD, status: 'missing', violations: [], evidenceId: 'evd_2' },
        hit('show slb session mirror'),
      ],
    },
  };
}

test('the recompose check accepts relocated text and refuses invented text, wrong buckets and missing cases', () => {
  const manifest = prep(fixture, 'mindmap.json');
  const machine = machineFor(manifest);
  const good = checkRecompose(manifest, machine);
  assert.deepEqual(good.violations, []);
  const bad = structuredClone(machine);
  bad.cases[0].contract.expectation = '显示 timeout 90 秒';
  bad.cases[1].expectations[1].origin = 'expectation:check9';
  bad.cases[2].bucket = 'exp_recipe';
  bad.cases.pop();
  bad.cases[0].origin.intent = 'manual:guide:12';
  const codes = checkRecompose(manifest, bad).violations.map((v) => `${v.code}:${v.autoid}`);
  assert.ok(codes.includes('case_verbatim_mismatch:100000000000000001'), 'one added character is invention');
  assert.ok(codes.includes('origin_invalid:100000000000000001'), 'a manual is never a contract source');
  assert.ok(codes.includes('origin_unresolved:100000000000000002'));
  assert.ok(codes.includes('source_incomplete:100000000000000004'));
  assert.ok(codes.includes('case_not_recomposed:100000000000000005'));
  const external = structuredClone(machine);
  external.cases[0].expectations[0] = { n: 1, text: 'x', origin: 'defect:zentao:BUG-77:title' };
  const outcome = checkRecompose(manifest, external);
  assert.equal(outcome.disclosures[0].note, 'external source; checked by the server');
});

test('the gate passes a sound case and names what is wrong in the others', () => {
  const manifest = prep(fixture, 'mindmap.json');
  const machine = machineFor(manifest);
  const cases = casesFor(manifest);
  const entry = (id) => machine.cases.find((c) => c.autoid === id);
  const mcase = (id) => manifest.cases.find((c) => c.autoid === id);
  const run = (item, id = item.autoid) => gateCase(item, entry(id), mcase(id), BUILD, destructivePatterns());
  assert.deepEqual(run(cases['100000000000000002']).violations, []);
  const missing = run(cases['100000000000000005']);
  assert.equal(missing.terminal, 'unsupported_feature');
  assert.ok(missing.violations.some((v) => v.code === 'command_not_in_tree'));
  const codes = (item) => run(item).violations.map((v) => v.code);
  const broken = structuredClone(cases['100000000000000001']);
  broken.command_receipts = [];
  broken.blocks[0].asserts[0].pattern = '(';
  broken.description.intent_verbatim += ' ';
  assert.deepEqual(codes(broken).sort(), ['assertion_regex_invalid', 'command_unverified', 'intent_verbatim_mismatch']);
  const doubled = structuredClone(cases['100000000000000002']);
  doubled.blocks[1].asserts[0].expectation_id = 'u1:100000000000000002:2:0';
  assert.ok(codes(doubled).includes('expectation_bijection_failed'));
  const destructive = structuredClone(cases['100000000000000001']);
  destructive.init_commands = ['system reboot'];
  destructive.command_receipts.push(hit('system reboot'));
  assert.ok(codes(destructive).includes('destructive_command'));
  const split = structuredClone(cases['100000000000000002']);
  split.blocks[0].cmds = [...'slb'];
  assert.ok(codes(split).includes('cmds_split_into_characters'));
  const extra = { ...structuredClone(cases['100000000000000001']), steps: [] };
  assert.ok(codes(extra).includes('body_keys_mismatch'));
  const otherBuild = structuredClone(cases['100000000000000001']);
  otherBuild.command_receipts[0].build = 'Rel_SYN_9_8_0_1';
  assert.ok(codes(otherBuild).includes('command_receipt_other_build'));
});

test('emit writes the A–I workbook per case and merged, with the sentinel last, and the same bytes every time', (t) => {
  const batch = batchDir(t);
  const manifest = prep(fixture, 'mindmap.json');
  writeJson(join(batch, 'manifest.json'), manifest);
  writeJson(join(batch, 'machine_mindmap.json'), machineFor(manifest));
  mkdirSync(join(batch, 'cases'), { recursive: true });
  for (const [id, item] of Object.entries(casesFor(manifest))) writeJson(join(batch, 'cases', `${id}.json`), item);
  writeJson(join(batch, 'gate_report.json'), gateBatch(batch));
  const report = emitBatch(batch, 'tester');
  assert.deepEqual(report.totals, { cases: 4, emitted_unverified: 2, needs_decision: 1, unsupported_feature: 1 });
  assert.equal(report.merged.case_count, 2);
  assert.equal(report.merged.check_point_count, 3);

  const bytes = readFileSync(join(batch, 'case.xlsx'));
  const sheet = readXlsx(bytes);
  assert.equal(sheet.sheet, '执行');
  assert.deepEqual(sheet.hidden, [1], 'the contract marker row is hidden');
  const header = sheet.rows.findIndex((row) => HEADERS.every((h, i) => row[i] === h));
  const data = sheet.rows.slice(header + 1);
  assert.deepEqual(data[0].slice(2, 4), [0, 'Author         : tester\nmindmap.json']);
  // The first case: one observation row and one check_point, then a blank row.
  assert.deepEqual(data[1], ['100000000000000001', 'P1', 2, '查看会话超时配置', 'APV_0', 'cmd_config', 'show slb session timeout']);
  assert.deepEqual(data[2], [, , 3, '显示 timeout 90', 'check_point', 'found', 'timeout\\s+90']);
  assert.deepEqual(data[3], []);
  // The second: its init commands become its first step; statement types count up from 2.
  assert.deepEqual(data[4].slice(0, 7), ['100000000000000002', 'P1', 2, '初始化配置', 'APV_0', 'cmds_config', 'slb session clear statistics']);
  assert.deepEqual(data.slice(4, 11).map((row) => row[2]), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(data[9].slice(4, 7), ['time', 'sleep', '2']);
  assert.deepEqual(data[11], []);
  assert.deepEqual(data[12], ['999999999999999', 'P9', 2, 'sentinel', 'time', 'sleep', '1']);
  assert.deepEqual(readBack(bytes).autoids, ['100000000000000001', '100000000000000002', '999999999999999']);

  const unsuccessful = readFileSync(join(batch, 'unsuccessful_cases.md'), 'utf8');
  assert.match(unsuccessful, /启用会话镜像 · 100000000000000005/);
  assert.match(unsuccessful, /command_not_in_tree/);
  assert.match(unsuccessful, /没有写怎样判断间隔已生效/);
  assert.match(readFileSync(join(batch, 'delivery_report.md'), 'utf8'), /还没有上机执行/);

  emitBatch(batch, 'tester');
  assert.equal(sha256(readFileSync(join(batch, 'case.xlsx'))), sha256(bytes), 'the same input gives the same bytes');
  const single = readXlsx(readFileSync(join(batch, 'cases', '100000000000000001.xlsx')));
  assert.deepEqual(
    single.rows.filter((row) => row[0] && /^\d+$/.test(String(row[0]))).map((row) => row[0]),
    ['100000000000000001', '999999999999999'],
  );
});
