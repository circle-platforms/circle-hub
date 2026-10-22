// Every pack of this package, staged exactly as it is published, against the real validator of the pack registry and its
// publish check (hub/runs api: readPackDirectory, validatePack, runPublishCheck, refusalsOf), without a database. The
// registry publication itself (records, owner, activation) runs in packs/workflow/case-review-verify/end-to-end.test.ts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AXES } from '../../../contracts/generated/vocabulary.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import { StartRunInput } from '../../../contracts/src/tools.ts';
import { readPackDirectory, refusalsOf, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { PACK_DIRECTORIES, manifestProblems, readManifest, stagePack } from './packaging.ts';
import { listSamples, sampleText, samples as draftSamples } from './testing/samples.ts';
import { samples as verifySamples } from '../case-review-verify/testing/samples.ts';

const KINDS: Record<string, string> = {
  'case-review': 'workflow',
  'case-review-verify': 'workflow',
  apv: 'product',
  'lumen-api': 'product',
  'agile-platform': 'system',
  plm: 'system',
  'build-site': 'system',
  'manual-store': 'system',
  openkm: 'system',
};

let temp: string;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'circle-hub-packs-'));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('every pack of this package', () => {
  for (const [id, kind] of Object.entries(KINDS)) {
    it(`${id}: pack.json is current, the pack validates and its publish check passes`, async () => {
      assert.deepEqual(await manifestProblems(PACK_DIRECTORIES[id]), [], `run node packs/workflow/case-review/packaging.ts sign ${id}`);
      const manifest = await readManifest(PACK_DIRECTORIES[id]);
      assert.deepEqual([manifest.id, manifest.kind], [id, kind]);
      const staged = await stagePack(PACK_DIRECTORIES[id], join(temp, id));
      const read = await readPackDirectory(staged);
      assert.ok(read.ok, JSON.stringify(!read.ok ? read.problems : []).slice(0, 2000));
      const validated = await validatePack(read.pack);
      assert.ok(validated.ok, JSON.stringify(!validated.ok ? validated.problems : []).slice(0, 2000));
      const report = await runPublishCheck({ pack: validated.pack, packDir: staged, sandbox: { requireOsIsolation: await osIsolationAvailable() } });
      assert.deepEqual(refusalsOf(report, validated.pack), []);
      if (kind === 'workflow') {
        assert.ok(report.samples.total > 0 && report.samples.failed === 0);
        for (const check of report.checks) assert.ok(check.positive > 0 && check.negative > 0, check.check);
        const skill = await readFile(join(staged, 'SKILL.md'), 'utf8');
        assert.ok(skill.length <= 8000, `SKILL.md has ${skill.length} characters`);
      }
      // No test, README, api.ts or test support is published.
      for (const file of manifest.files) assert.ok(!/\.test\.ts$|README|^api\.ts$|^testing\//.test(file.path), file.path);
    });
  }
});

/**
 * String-literal unions and arrays of two or more values that all belong to one vocabulary axis: an enumeration written by
 * hand (brief section 10). A subset derived from the generated type or schema (Extract<>, Exclude<>, .extract(), .exclude())
 * is checked by the compiler and allowed.
 */
function handWrittenAxes(text: string): Array<{ line: number; axis: string; values: string[] }> {
  const axes = Object.entries(AXES).map(([name, axis]) => [name, new Set<string>(axis.values.map((v) => v.code))] as const);
  const out: Array<{ line: number; axis: string; values: string[] }> = [];
  for (const pattern of [/((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/g, /\[\s*((?:'[a-z_]+'\s*,\s*)+'[a-z_]+')\s*,?\s*\]/g]) {
    for (const m of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 120), m.index);
      if (/(?:Extract|Exclude)<[^<>]*,\s*$|\.(?:extract|exclude)\(\s*\[?\s*$/.test(before)) continue;
      const values = [...m[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]);
      for (const [axis, set] of axes) {
        if (values.every((v) => set.has(v))) out.push({ line: text.slice(0, m.index).split('\n').length, axis, values });
      }
    }
  }
  return out;
}

describe('the vocabulary', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const owned = ['packs/workflow/case-review', 'packs/workflow/case-review-verify', 'packs/product', 'packs/system', 'tests/fixtures'];
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir))
      .sort()
      .flatMap((name) => {
        const path = `${dir}/${name}`;
        if (statSync(join(root, path)).isDirectory()) return sources(path);
        return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
      });

  it('the scan finds an axis written by hand and lets a derived subset pass', () => {
    assert.deepEqual(handWrittenAxes("type K = 'definition' | 'behaviour' | 'case';").map((h) => h.axis), ['entry_kind']);
    assert.deepEqual(handWrittenAxes("const roles = ['user', 'admin'];").map((h) => h.axis), ['permission_role']);
    assert.deepEqual(handWrittenAxes("type B = Extract<ProvenanceType, 'declared' | 'projected'>; const r = SourceRoleSchema.extract(['expected', 'hint']);"), []);
    assert.deepEqual(handWrittenAxes("type F = 'APV' | 'NSAE' | 'other'; const f = ['positive', 'negative'];"), []);
  });

  it('is never written by hand in the code of this package: the generated types and schemas are used', () => {
    const found = owned.flatMap(sources).flatMap((path) => handWrittenAxes(readFileSync(join(root, path), 'utf8')).map((h) => `${path}:${h.line} ${h.axis} ${h.values.join(' | ')}`));
    assert.deepEqual(found, []);
  });
});

/** An example with its <placeholders> filled in by what they stand for, so that it can be checked against the contract. */
function filled(example: unknown): unknown {
  let n = 0;
  const fill = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => fill(v, key));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k)]));
    if (typeof value !== 'string' || !value.includes('<')) return value;
    if (key === 'run' || key === 'predecessor') return 'run_01m5h9zm2nhzbz2hrfjfb6azta';
    if (key === 'context') return 'c'.repeat(64);
    return value
      .replace(/(src|rec):<[^>]+>/g, (_all, scheme: string) => `${scheme}:${(scheme === 'src' ? 'a' : 'b').repeat(64)}`)
      .replace(/\/<[^>]+>/g, () => `/${n++}`)
      .replace(/<[^>]+>/g, () => `p${n++}`);
  };
  return fill(example, '');
}

describe('the examples', () => {
  const example = (id: string, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(PACK_DIRECTORIES[id], 'examples', name), 'utf8')) as Record<string, unknown>;

  it('are a start_run and a submit_result of the contract once their placeholders are filled in', () => {
    for (const id of ['case-review', 'case-review-verify']) {
      const start = StartRunInput.safeParse((filled(example(id, 'start-run.json')) as Record<string, unknown>).start_run);
      assert.ok(start.success, `${id}: ${JSON.stringify(start.error?.issues?.slice(0, 3))}`);
      const submit = Submission.safeParse((filled(example(id, 'submission.json')) as Record<string, unknown>).submit_result);
      assert.ok(submit.success, `${id}: ${JSON.stringify(submit.error?.issues?.slice(0, 3))}`);
    }
  });

  it('of the draft write the context digest of every judged item and carry an unchanged item over, as SKILL.md tells', async () => {
    const submission = example('case-review', 'submission.json').submit_result as { items: Array<Record<string, unknown>> };
    const judged = submission.items.filter((i) => i.slots !== undefined);
    assert.ok(judged.length > 0 && judged.every((i) => typeof i.context === 'string'), 'every item with a slot record names its context');
    assert.ok(submission.items.some((i) => typeof i.reuse === 'string' && i.slots === undefined), 'an item offered for reuse is carried over');
    const findings = judged.flatMap((i) => (i.slots as { findings: Array<Record<string, unknown>> }).findings);
    assert.ok(findings.every((f) => typeof f.location === 'string' && Array.isArray(f.quotes) && f.quotes.length > 0), 'every finding has a location and a quotation');
    const skill = await readFile(join(PACK_DIRECTORIES['case-review'], 'SKILL.md'), 'utf8');
    for (const word of ['`context`', '`predecessor`', '`reuse`']) assert.ok(skill.includes(word), `SKILL.md explains ${word}`);
  });
});

describe('the samples', () => {
  it('on disk are what the generators write, each tagged with its source', async () => {
    for (const [id, entries] of [['case-review', draftSamples()], ['case-review-verify', verifySamples()]] as const) {
      const dir = join(PACK_DIRECTORIES[id], 'samples');
      assert.deepEqual(await listSamples(dir), entries.map((e) => `${e.folder}/${e.sample.id}.json`).sort(), `run node packs/workflow/${id}/testing/samples.ts write`);
      for (const entry of entries) {
        assert.equal(await readFile(join(dir, entry.folder, `${entry.sample.id}.json`), 'utf8'), sampleText(entry), entry.sample.id);
        assert.equal(entry.sample.source, 'author');
      }
    }
  });
});
