// The case-compile pack as files: the manifest matches the listed files, the declarations hang together (inputs,
// product catalogs, checks and requirements), every code the functions give is declared in codes.json, the samples
// cover every check in both polarities, and the examples parse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PackManifest } from '../../../contracts/src/pack.ts';
import { computeManifest, packFiles, PACK_DIR } from './pack-files.ts';

const read = (path: string): string => readFileSync(join(PACK_DIR, path), 'utf8');
const json = (path: string): unknown => JSON.parse(read(path));

describe('the case-compile pack files', () => {
  it('pack.json is the fresh manifest of exactly the pack files', async () => {
    const manifest = await computeManifest();
    assert.ok(PackManifest.safeParse(manifest).success);
    assert.deepEqual(JSON.parse(read('pack.json')), JSON.parse(JSON.stringify(manifest)));
    const files = await packFiles();
    for (const top of ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md']) assert.ok(files.includes(top), top);
    assert.ok(!files.some((path) => path.endsWith('.test.ts') || path === 'functions/test-support.ts' || path.startsWith('testing/')), 'tests and the harness stay out');
  });

  it('declares the inputs, the catalog binding and the checks', () => {
    const workflow = json('workflow.json') as { inputs: Array<{ slot: string; accepts: string[]; required: boolean }>; product: { catalogs: string[] }; context: string[] };
    assert.deepEqual(
      workflow.inputs.map((input) => [input.slot, input.accepts, input.required]),
      [
        ['subject', ['agile:mindmap', 'application/json'], true],
        ['contract', ['doc:doc'], true],
        ['inventory', ['doc:doc'], true],
      ],
    );
    assert.deepEqual(workflow.product.catalogs, ['commands@1']);
    assert.deepEqual(workflow.context, ['leases']);
    const checks = json('checks.json') as { checks: Array<{ id: string; tier: string; basis?: string }> };
    assert.deepEqual(
      checks.checks.map((check) => check.id),
      ['contract_shape', 'bed_addresses', 'commands_catalog', 'expected_sources', 'expected_quotes', 'deterministic_plan'],
    );
    for (const check of checks.checks) {
      assert.equal(check.tier, 'blocking', check.id);
      assert.ok(typeof check.basis === 'string' && check.basis.length > 0, `blocking check ${check.id} names its basis`);
    }
    const requirements = json('requirements.json') as { requirements: Array<{ key: string; checks: string[] }> };
    const byChecks = requirements.requirements.flatMap((requirement) => requirement.checks);
    assert.deepEqual([...byChecks].sort(), [...checks.checks.map((check) => check.id)].sort(), 'every check serves a requirement');
  });

  it('declares every code the functions give', () => {
    const codes = json('tables/codes.json') as { violations: Array<{ code: string }>; refusals: Array<{ code: string }>; warnings: Array<{ code: string }> };
    const declared = new Set([...codes.violations, ...codes.refusals, ...codes.warnings].map((entry) => entry.code));
    const used = new Set<string>();
    for (const file of ['functions/checks.ts', 'functions/plan.ts', 'functions/project.ts']) {
      for (const match of read(file).matchAll(/case-compile\.([a-z_]+)/g)) used.add(`case-compile.${match[1]}`);
    }
    for (const code of used) assert.ok(declared.has(code), `${code} 没有在 codes.json 里声明`);
  });

  it('has a positive and a negative sample of each check', () => {
    const checks = (json('checks.json') as { checks: Array<{ id: string }> }).checks.map((check) => check.id);
    const files: Record<string, string[]> = {
      positive: ['contract-valid.json', 'addresses-valid.json', 'commands-valid.json', 'expects-sourced.json', 'quotes-verbatim.json', 'plan-deterministic.json'],
      negative: ['method-forbidden.json', 'listen-blind.json', 'backend-not-server.json', 'commands-out-of-range.json', 'commands-not-member.json', 'expect-without-source.json', 'expect-not-in-quote.json', 'quote-mismatch.json', 'plan-in-slots.json'],
    };
    for (const [polarity, names] of Object.entries(files)) {
      const seen = new Set<string>();
      for (const file of names) {
        const sample = json(`samples/${polarity}/${file}`) as { check: string; expect: Array<{ verdict: string; code?: string; reason?: string }> };
        seen.add(sample.check);
        if (polarity === 'positive') assert.ok(sample.expect.every((outcome) => outcome.verdict === 'support'), `${file} 正例要全是支持`);
        else assert.ok(sample.expect.some((outcome) => outcome.verdict === 'refute' && outcome.code === sample.expect[0].code), `${file} 负例要有反驳码`);
      }
      for (const check of checks) assert.ok(seen.has(check), `${polarity} 缺少 ${check} 的样例`);
    }
  });

  it('the examples parse and carry the synthetic declaration', () => {
    const contract = json('examples/compile-contract.json') as { schema: string; synthetic: boolean };
    assert.equal(contract.schema, 'compile-contract@1');
    assert.equal(contract.synthetic, true);
    const manifest = json('examples/bed-topology.json') as { schema: string };
    assert.equal(manifest.schema, 'test-bed-manifest@1');
    const start = json('examples/start-run.json') as { inputs: { contract: { external: string }; inventory: { external: string } } };
    assert.equal(start.inputs.contract.external, 'doc:doc:compile-contract');
    assert.equal(start.inputs.inventory.external, 'doc:doc:bed-topology');
    const submission = read('examples/submit-result.json');
    assert.ok(!submission.includes('plan_json'), '执行计划由 Hub 从槽位生成，提交里没有 plan_json');
    assert.match(submission, /"bucket": "bed-a"/);
    assert.match(submission, /"quotes": \[/);
  });

  it('SKILL.md is short, Chinese, and carries the two markers', () => {
    const skill = read('SKILL.md');
    assert.ok(skill.length <= 8000, `${skill.length} 字符`);
    assert.match(skill, /按合成合约核对/);
    assert.match(skill, /不证明在真实设备上跑得通/);
    assert.match(skill, /受限结构/);
  });
});
