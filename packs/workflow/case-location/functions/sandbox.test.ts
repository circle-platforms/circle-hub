// Every entry point runs unchanged in the Hub sandbox (hub/rules): only modules inside the pack are loaded at run time, the
// type imports are erased, and the output equals the direct call. The check also runs through runCheck, as a run calls it.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { callPackFunction, osIsolationAvailable, runCheck } from '../../../../hub/rules/api.ts';
import candidates from './candidates.ts';
import check from './check.ts';
import expected from './expected.ts';
import locate from './locate.ts';
import project from './project.ts';
import subject from './subject.ts';
import { BOUND, boundDocument, smallMap } from './test-support.ts';
import type { ProjectedItem } from './types.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

const TREE = { root: 'FAMY', ancestors: ['030：FAMX/FAMY测试项目', '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] };
const inputs = [boundDocument('24301', smallMap('24301', 'x'), { title: 'bug 61001 会话保持', ...TREE }), boundDocument('24302', smallMap('24302', 'x'), { title: '设备基础配置', root: 'FAMX', ancestors: ['通用用例'] })];
const parameters = { line: '10.6' };
const projection = { inputs, parameters, context: { ...BOUND, parameters } };
const items = (project(projection) as { items: ProjectedItem[] }).items;
const runSubject = {
  applies: 'run',
  items: items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/kityminder@1/${it.location.selector}`, fields: it.fields })),
  context: { ...BOUND, parameters },
};
const built = subject(runSubject);

const cases: Array<{ module: string; input: unknown; direct: (input: unknown) => unknown }> = [
  { module: 'functions/project.ts', input: projection, direct: project },
  { module: 'functions/expected.ts', input: { ...projection, items }, direct: expected },
  { module: 'functions/subject.ts', input: runSubject, direct: subject },
  { module: 'functions/check.ts', input: { check: 'locate', table: null, subject: built, context: { pack: 'case-location' }, sources: {} }, direct: check },
  { module: 'functions/candidates.ts', input: { check: 'candidates', table: null, subject: built, context: { pack: 'case-location' }, sources: {} }, direct: candidates },
  { module: 'functions/locate.ts', input: { case_id: 'x', root: 'FAMY', ancestors: TREE.ancestors, title: '需求20931', names: ['FAMX', 'FAMY'], product: 'famx' }, direct: locate },
];

describe('pack functions in the Hub sandbox', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  for (const item of cases) {
    it(`${item.module} gives the same result as the direct call`, async () => {
      const result = await callPackFunction({ packDir, module: item.module }, item.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(item.direct(item.input))));
    });
  }

  it('runs as the declared check through runCheck, with the tier and outcomes a run gets', async () => {
    const outcomes = await runCheck(
      { id: 'locate', function: { module: 'functions/check.ts' }, tier: 'advisory' },
      { subject: built, context: { run: 'run_0000000000000000000000000a', requirement: 'location', pack: 'case-location' }, packDir, sourceTexts: {} },
    );
    assert.deepEqual(outcomes, check({ subject: built }));
    assert.deepEqual(
      outcomes.map((o) => [o.item, o.verdict, o.reason ?? null]),
      [
        ['24301', 'support', null],
        ['24302', 'unknown', 'missing_input'],
      ],
    );
    // The candidates check through runCheck too: without builds in the context every located line is an unknown, never a pass.
    const candidatesOut = await runCheck(
      { id: 'candidates', function: { module: 'functions/candidates.ts' }, tier: 'advisory' },
      { subject: built, context: { run: 'run_0000000000000000000000000a', requirement: 'build_candidates', pack: 'case-location' }, packDir, sourceTexts: {} },
    );
    assert.deepEqual(candidatesOut, candidates({ subject: built }));
    assert.deepEqual(
      candidatesOut.map((o) => [o.item, o.verdict, o.reason ?? null]),
      [
        ['24301', 'unknown', 'missing_input'],
        ['24302', 'unknown', 'missing_input'],
      ],
    );
  });
});
