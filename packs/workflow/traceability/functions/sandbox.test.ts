// Every entry point runs unchanged in the Hub sandbox (hub/rules): only modules inside the pack are loaded at run time, the
// type imports are erased, and the output equals the direct call. Both checks also run through runCheck, as a run calls them.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { callPackFunction, osIsolationAvailable, runCheck } from '../../../../hub/rules/api.ts';
import check from './check.ts';
import counts from './counts.ts';
import project from './project.ts';
import subject from './subject.ts';
import { boundPair, caseEntry, defectEntry } from './test-support.ts';
import type { ProjectedItem } from './types.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };
const pair = boundPair([defectEntry({ bug: '73001' }), defectEntry({ bug: '73002', status: 'known' })], [caseEntry({ defects: ['73001'], case: 'C-1', title: '沙箱里的用例' })]);
const projection = { inputs: pair.inputs, parameters: {}, context: CONTEXT };
const items = (project(projection) as { items: ProjectedItem[]; groups?: Record<string, unknown>[] }).items;
const groups = (project(projection) as { groups: Record<string, unknown>[] }).groups;
const runSubject = {
  applies: 'run',
  items: items.map((it) => ({ id: it.id, label: it.label, location: `src:${(it.location as { source: string }).source}/json@1/${(it.location as { selector: string }).selector}`, fields: it.fields })),
  context: { ...CONTEXT, groups },
};
const built = subject(runSubject);

const cases: Array<{ module: string; input: unknown; direct: (input: unknown) => unknown }> = [
  { module: 'functions/project.ts', input: projection, direct: project },
  { module: 'functions/subject.ts', input: runSubject, direct: subject },
  { module: 'functions/check.ts', input: { check: 'traced', table: null, subject: built, context: { pack: 'traceability' }, sources: {} }, direct: check },
  { module: 'functions/counts.ts', input: { check: 'counts', table: null, subject: built, context: { pack: 'traceability' }, sources: {} }, direct: counts },
];

describe('pack functions in the Hub sandbox', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  for (const item of cases) {
    it(`${item.module} gives the same result as the direct call`, async () => {
      const result = await callPackFunction({ packDir, module: item.module }, item.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(item.direct(item.input))));
    });
  }

  it('runs both declared checks through runCheck, with the tier and outcomes a run gets', async () => {
    const traced = await runCheck(
      { id: 'traced', function: { module: 'functions/check.ts' }, tier: 'advisory' },
      { subject: built, context: { run: 'run_0000000000000000000000000a', requirement: 'traced', pack: 'traceability' }, packDir, sourceTexts: {} },
    );
    assert.deepEqual(traced, check({ subject: built }));
    assert.deepEqual(
      traced.map((o) => [o.item, o.verdict, o.reason ?? null]),
      [
        ['73001', 'support', null],
        ['73002', 'unknown', 'missing_input'],
      ],
    );
    const counted = await runCheck(
      { id: 'counts', function: { module: 'functions/counts.ts' }, tier: 'advisory' },
      { subject: built, context: { run: 'run_0000000000000000000000000a', requirement: 'counts', pack: 'traceability' }, packDir, sourceTexts: {} },
    );
    assert.deepEqual(counted, counts({ subject: built }));
    assert.deepEqual(
      counted.map((o) => [o.verdict, o.item ?? null]),
      [['support', null]],
    );
  });
});
