// An unknown build name is answered as a claim (D05 R[8]): the lookup's rule, scope and time, and every build a run can
// lock as options with their coverage (A05 R[1]): version lines newest first, inside a line the builds with a root of
// their own first; a list cut at the limit lists every such build first and says how many each line has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StartRunInput } from '../../../contracts/src/tools.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import type { LoadedWorkflow, ProductHandle, RootInfo } from '../../ports.ts';
import type { Principal } from '../../records/api.ts';
import { errorLine } from '../../server/text.ts';
import type { EngineContext } from './deps.ts';
import { Refusal } from './errors.ts';
import { resolveTarget } from './target.ts';

const root = 'a'.repeat(64), composition = 'b'.repeat(64);
const product = { id: 'meridian', version: '1.0.0', digest: 'd'.repeat(64), kind: 'product', directory: '/synthetic',
  product: { schema: 'product@1', id: 'meridian', title: 'Meridian', names: ['Meridian'], catalogs: [], producers: [] } } as ProductHandle;
const workflow = { pack: { id: 'synthetic', digest: 'c'.repeat(64) }, workflow: { product: { id: 'meridian', catalogs: [] } } } as unknown as LoadedWorkflow;
const user = { id: 'usr_00000000000000000000000000', role: 'user' } as Principal;
const AT = '2026-11-01T00:00:00.000Z';

const build = (name: string, line: string, own: boolean): KnownBuild => ({ name, family: 'Meridian', line, base: name, platform: null, built_at: null, released_at: null, root: own ? root : null, sources: {} });

/** A product whose seedling lines lend a root to every build of the line; other lines only to builds with their own. */
function context(builds: KnownBuild[], seedlingLines: ReadonlySet<string>): EngineContext {
  const info = (line: string): RootInfo => ({ root, composition, product: 'meridian', build: builds.find((b) => b.line === line)!, produced_at: AT });
  const knowledge = {
    async builds() { return builds; },
    async resolveBuild(_product: string, name: string) { return builds.find((b) => b.name.toLowerCase() === name.toLowerCase()) ?? null; },
    async seedlingRoot(_product: string, line: string) { return seedlingLines.has(line) ? info(line) : null; },
    async unversionedRoot() { return null; },
  };
  const packs = { async readableProducts() { return new Set(['meridian']); }, async productByName() { return product; }, async productById() { return product; }, async products() { return [product]; } };
  return { deps: { packs, knowledge }, log() {} } as unknown as EngineContext;
}

async function refusalOf(ctx: EngineContext, name: string): Promise<ProtocolError> {
  try {
    await resolveTarget(ctx, user, workflow, StartRunInput.parse({ pack: 'synthetic', product: 'Meridian', build: name, inputs: {} }), AT, 'synthetic');
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    assert.equal(error.errors.length, 1);
    return error.errors[0]!;
  }
  assert.fail('an unknown build name is refused');
}

test('an unknown build name lists every lockable build, newest line first, own roots first, with the lookup as a claim', async () => {
  const builds = [
    build('Rel_MERIDIAN_10_8_1_66', '10.8.1', true),
    build('Rel_MERIDIAN_10_8_1_62', '10.8.1', true),
    build('Beta_MERIDIAN_10_9_0_12', '10.9', false),
    build('Beta_MERIDIAN_10_9_0_585', '10.9', true),
    build('Rel_MERIDIAN_10_8_2_8', '10.8.2', true),
    build('Beta_MERIDIAN_10_9_0_700', '10.9', false),
    build('Rel_MERIDIAN_10_7_0_61', '10.7', false),
  ];
  const error = await refusalOf(context(builds, new Set(['10.9'])), '10.9.0.585');
  assert.equal(error.code, 'REFERENCE_UNRESOLVED');
  assert.equal(error.message, '产品线 meridian 里没有名字或别名是“10.9.0.585”的构建');
  assert.equal(error.warrant, 'runs.build_name@1');
  assert.equal(error.provenance, 'projected');
  assert.equal(error.collected_at, AT);
  assert.deepEqual({ ...error.coverage, note: undefined }, { complete: true, examined: 7, total: 7, note: undefined });
  // 10.7 has neither a root of its own nor a seedling: not lockable, not an option.
  assert.deepEqual(error.options, ['Beta_MERIDIAN_10_9_0_585', 'Beta_MERIDIAN_10_9_0_12', 'Beta_MERIDIAN_10_9_0_700', 'Rel_MERIDIAN_10_8_2_8', 'Rel_MERIDIAN_10_8_1_66', 'Rel_MERIDIAN_10_8_1_62']);
  assert.equal(error.options_coverage?.complete, true);
  assert.equal(error.options_coverage?.examined, 6);
  assert.equal(error.options_coverage?.total, 6);
  assert.match(error.options_coverage?.note ?? '', /各版本线：10\.9 3 个（有自己知识根的 1 个）、10\.8\.2 1 个、10\.8\.1 2 个/);
  const line = errorLine(error);
  assert.match(line, /限定：投影，采集于 2026-11-01T00:00:00.000Z，查找范围完整：已查 7，共 7（名字或别名不分大小写逐字相等才算/);
  assert.match(line, /规则：runs\.build_name@1/);
  assert.match(line, /可选（共 6 个，全部列出；可以锁定知识根的构建，按版本线从新到旧/);
  assert.ok(line.includes('Beta_MERIDIAN_10_9_0_585'), 'the newest line build with its own root is listed, not hidden behind a cut');
});

test('a list past the limit names every build with a root of its own first and says how to list one line in full', async () => {
  const builds: KnownBuild[] = [];
  for (let i = 0; i < 450; i++) builds.push(build(`Rel_MERIDIAN_10_8_0_${i}`, '10.8.0', false));
  builds.push(build('Rel_MERIDIAN_10_8_0_own', '10.8.0', true));
  for (let i = 0; i < 30; i++) builds.push(build(`Beta_MERIDIAN_10_9_0_${i}`, '10.9', i % 10 === 0));
  const error = await refusalOf(context(builds, new Set(['10.8.0', '10.9'])), 'no-such-build');
  assert.equal(error.options?.length, 400);
  assert.deepEqual(error.options?.slice(0, 4), ['Beta_MERIDIAN_10_9_0_0', 'Beta_MERIDIAN_10_9_0_10', 'Beta_MERIDIAN_10_9_0_20', 'Rel_MERIDIAN_10_8_0_own']);
  assert.equal(error.options_coverage?.complete, false);
  assert.equal(error.options_coverage?.examined, 400);
  assert.equal(error.options_coverage?.total, 481);
  assert.match(error.options_coverage?.note ?? '', /先按版本线从新到旧列出全部有自己知识根的，再列其余的/);
  assert.match(error.options_coverage?.note ?? '', /10\.9 30 个（有自己知识根的 3 个）、10\.8\.0 451 个（有自己知识根的 1 个）/);
  assert.match(error.options_coverage?.note ?? '', /start_run 写上 version（版本线），这里就只列这条线的全部构建/);
  assert.match(errorLine(error), /可选（列出 400 个，共 481 个；/);
});
