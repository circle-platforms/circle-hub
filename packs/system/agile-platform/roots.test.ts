import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
// agile:tree:roots: the read of every configured root at once (round sizes, titles from the listing, documents with their
// folders, completeness, the revision), checked on its own against the answers of the case-index corpus and through the
// real connectors against loopback stubs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MAX_READ_ROUNDS, ReadPlanOutput, ReadProjectionOutput } from '../../../contracts/src/resources.ts';
import { json, notFound, passwordDigest, startAgileStub, startStub, type AgileStub, type StubServer } from '../../../hub/connectors/testing/api.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { CASE_INDEX_ACCOUNT, caseCorpus, caseIndexAgileOptions, listingAnswer, subtreeAnswer, type Corpus } from '../../../tests/fixtures/case-index/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { MAX_ROOTS, READ_ROUNDS, ROOTS_IN_FLIGHT, ROOTS_KEY, rootsContent, rootsOf, rootsPlan, rootsProject, treePlan, treeProject, type RootsContent } from './functions/agile.ts';

const corpus = caseCorpus();

type Answer = { ok: boolean; json?: unknown; sha256?: string | null };

/** The answer of the platform to one planned request, as the connectors hand it to the read functions. */
function answer(c: Corpus, request: { route: string; body?: unknown }, failing: ReadonlySet<string> = new Set()): Answer {
  const body = (request.body ?? {}) as { page?: number; id?: number | string };
  if (request.route === 'roots') return { ok: true, json: listingAnswer(c, Number(body.page)) };
  const id = String(body.id);
  if (failing.has(id)) return { ok: false };
  const value = subtreeAnswer(c, id);
  return value.code === 1000 ? { ok: true, json: value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') } : { ok: false };
}

/** Runs the planner the way the connectors do, round after round, and returns every round's requests and the answers. */
function runPlan(c: Corpus, settings: Record<string, unknown>, failing: ReadonlySet<string> = new Set()): { rounds: Array<Array<{ key: string; route: string; body?: unknown }>>; responses: Record<string, Answer> } {
  const responses: Record<string, Answer> = {};
  const rounds: Array<Array<{ key: string; route: string; body?: unknown }>> = [];
  for (let round = 1; round <= MAX_READ_ROUNDS; round++) {
    const plan = rootsPlan({ round, external: { key: ROOTS_KEY }, settings, responses });
    assert.ok(ReadPlanOutput.safeParse(plan).success, JSON.stringify(plan));
    assert.equal(plan.original, 'page-1');
    rounds.push(plan.requests);
    for (const request of plan.requests) {
      assert.ok(!Object.hasOwn(responses, request.key), `${request.key} is asked for once`);
      responses[request.key] = answer(c, request, failing);
    }
    if (plan.done) return { rounds, responses };
  }
  assert.fail('the plan did not say done in five rounds');
}

const contentOf = (output: unknown): RootsContent => (output as { artifacts: Array<{ name: string; json: RootsContent }> }).artifacts.find((a) => a.name === 'content')!.json;

describe('the plan of agile:tree:roots', () => {
  test('the round limit is the connectors\' and a key named roots is never a configured root', () => {
    assert.equal(READ_ROUNDS, MAX_READ_ROUNDS);
    assert.deepEqual(rootsOf({ roots: ['7811', ROOTS_KEY, 7812] }), ['7811', '7812']);
    assert.equal(treePlan({ round: 1, external: { key: ROOTS_KEY }, settings: { roots: ['7811'] } }).original, 'page-1', 'the tree read hands the key roots to the roots plan');
  });

  test('three roots: the listing page and the subtrees first, then the pages that name the roots, at most four requests a round', () => {
    const { rounds } = runPlan(corpus, { roots: corpus.roots });
    assert.deepEqual(rounds[0].map((r) => r.key), ['page-1', 'subtree-1', 'subtree-2', 'subtree-3']);
    assert.deepEqual(rounds[0].slice(1).map((r) => r.body), corpus.roots.map((id) => ({ id: Number(id) })), 'numeric ids go as numbers');
    // The subtree answer starts with the root node, so each title is known and no later listing page is required.
    assert.deepEqual(rounds[1], []);
    assert.equal(rounds.length, 2);
    assert.ok(rounds.every((r) => r.length <= ROOTS_IN_FLIGHT));
  });

  test('every configured root and its listing pages are read before reporting completion', () => {
    const listing = Array.from({ length: 95 }, (_, i) => ({ id: String(9000 + i), label: `根 ${i}` }));
    const trees = Object.fromEntries(listing.map((r) => [r.id, [{ label: '目录', id: `f${r.id}`, cases: [`d${r.id}`], children: [{ label: `文档 ${r.id}`, id: `d${r.id}`, cases: [], children: [] }] }]]));
    const wide: Corpus = { ...corpus, listing, trees };
    const configured = listing.slice(83, 95).map((r) => r.id);
    const { rounds, responses } = runPlan(wide, { roots: configured });
    assert.ok(rounds.length <= MAX_READ_ROUNDS);
    const keys = rounds.flat().map((r) => r.key);
    assert.equal(keys.filter((k) => k.startsWith('subtree-')).length, configured.length);
    const output = rootsProject({ external: { key: ROOTS_KEY }, settings: { roots: configured }, responses, original: 'page-1' });
    assert.ok(ReadProjectionOutput.safeParse(output).success);
    const content = contentOf(output);
    assert.equal(content.complete, true);
    assert.deepEqual(content.unread??[], []);
    assert.deepEqual(content.roots.map((r) => r.title), configured.map((id) => `根 ${Number(id) - 9000}`), 'titles found on pages 9 and 10');
  });

  test('a configured root listed on page 12 still gets its title', () => {
    const listing = Array.from({ length: 150 }, (_, i) => ({ id: String(8000 + i), label: `根 ${i}` }));
    listing[119] = { id: '7811', label: '合成产品' };
    const wide: Corpus = { ...corpus, listing, trees: { '7811': [] }, emptyFolders: [] };
    const settings = { roots: ['7811'] };
    const responses: Record<string, Answer> = {};
    let rounds = 0;
    for (let round = 1; round <= MAX_READ_ROUNDS; round++) {
      const plan = rootsPlan({ round, settings, responses });
      rounds = round;
      for (const request of plan.requests) {
        const body = (request.body ?? {}) as { page?: number; id?: number | string };
        responses[request.key] = request.route === 'roots' ? { ok: true, json: listingAnswer(wide, Number(body.page)) } : { ok: true, json: subtreeAnswer(wide, '7811') };
      }
      if (plan.done) break;
    }
    const content = rootsContent(settings, responses).content;
    assert.equal(content.roots[0]?.title, '合成产品');
    assert.equal(content.complete, true);
    assert.ok(rounds <= MAX_READ_ROUNDS);
  });

  test('total on hostile input: a valid plan and a valid projection whatever the settings and answers', () => {
    const cyclic: Record<string, unknown> = { label: 'x', id: 'c', cases: [], children: [] };
    (cyclic.children as unknown[]).push(cyclic);
    const settingsList: unknown[] = [null, 'roots', { roots: 'x' }, { roots: [null, {}, 1.5, -1, 'a b', ROOTS_KEY, '7811'] }, { roots: Array.from({ length: 40 }, (_, k) => String(k)) }];
    const answers: unknown[] = [
      null,
      { 'page-1': { ok: true, json: { code: 1000, data: { total: 1e12, list: 'x' } } } },
      { 'page-1': { ok: true, json: { data: [{ id: '7811', label: 5 }] } }, 'subtree-1': { ok: true, json: { data: [cyclic, null, 3, { id: { x: 1 }, children: 'x' }] } } },
      { 'page-1': { ok: false }, 'subtree-1': { ok: true, json: { data: 'not a list' } }, 'page-999999': { ok: true } },
    ];
    for (const settings of settingsList) {
      for (const responses of answers) {
        for (let round = 1; round <= MAX_READ_ROUNDS; round++) {
          const plan = rootsPlan({ round, external: { key: ROOTS_KEY }, settings, responses });
          assert.ok(ReadPlanOutput.safeParse(plan).success, JSON.stringify(plan).slice(0, 300));
          assert.equal(plan.concurrency,ROOTS_IN_FLIGHT);
        }
        const out = rootsProject({ external: { key: ROOTS_KEY }, settings, responses, original: 'page-1' });
        assert.ok(ReadProjectionOutput.safeParse(out).success, JSON.stringify(out).slice(0, 300));
      }
    }
  });

  test('no configured root: one request (the listing as the original), done at once', () => {
    const plan = rootsPlan({ round: 1, external: { key: ROOTS_KEY }, settings: {} });
    assert.deepEqual([plan.requests.map((r) => r.key), plan.done], [['page-1'], true]);
    const output = rootsProject({ external: { key: ROOTS_KEY }, settings: {}, responses: { 'page-1': answer(corpus, plan.requests[0]) }, original: 'page-1' }) as { complete?: boolean; note?: string };
    assert.equal(output.complete, false);
    assert.match(output.note ?? '', /没有可读的根编号/);
  });
});

describe('the content of agile:tree:roots', () => {
  const { responses } = runPlan(corpus, { roots: corpus.roots });
  const output = rootsProject({ external: { key: ROOTS_KEY }, settings: { roots: corpus.roots }, responses, original: 'page-1' }) as { revision: string; complete?: boolean };
  const content = contentOf(output);

  test('every root with its title, every document once with the folders above it from the root title down', () => {
    assert.ok(ReadProjectionOutput.safeParse(output).success);
    assert.equal(content.complete, true);
    assert.equal(output.complete, undefined);
    assert.deepEqual(content.roots, [
      { id: '7811', title: 'ORBIT' },
      { id: '7812', title: 'COMET' },
      { id: '7813', title: '演示产品' },
    ]);
    const byId = new Map(content.documents.map((d) => [d.id, d]));
    for (const truth of corpus.truth) {
      const doc = byId.get(truth.id);
      assert.ok(doc, truth.id);
      assert.deepEqual([doc.title, doc.ancestors, doc.root], [truth.title, truth.ancestors, truth.root], truth.id);
    }
    assert.equal(content.documents.length, corpus.truth.length + 1 + corpus.emptyFolders.length, 'the truth, the leaf the platform cannot serve, and the empty folders');
    for (const id of corpus.emptyFolders) assert.equal(content.documents.find((doc) => doc.id === id)?.listed, false, id);
    assert.ok(byId.has(corpus.badId), 'ids are listed as the tree gives them; the product pack decides what it can read');
    assert.equal(content.documents.filter((d) => d.id === corpus.repeated).length, 1, 'a document filed twice is listed once, at its first place');
  });

  test('the revision is the digest of the content: equal trees give one revision, a changed tree another', () => {
    assert.equal(output.revision, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
    const again = rootsProject({ external: { key: ROOTS_KEY }, settings: { roots: corpus.roots }, responses: runPlan(corpus, { roots: corpus.roots }).responses, original: 'page-1' }) as { revision: string };
    assert.equal(again.revision, output.revision);
    const moved = structuredClone(corpus);
    moved.trees['7812'][0].children[0].label = '059：10.7.1（改名）';
    const changed = rootsProject({ external: { key: ROOTS_KEY }, settings: { roots: corpus.roots }, responses: runPlan(moved, { roots: corpus.roots }).responses, original: 'page-1' }) as { revision: string };
    assert.notEqual(changed.revision, output.revision);
  });

  test('a subtree that cannot be read, or a root the listing does not name, makes the content incomplete and says which', () => {
    const failed = runPlan(corpus, { roots: corpus.roots }, new Set(['7812']));
    const out = rootsProject({ external: { key: ROOTS_KEY }, settings: { roots: corpus.roots }, responses: failed.responses, original: 'page-1' }) as { complete?: boolean; note?: string };
    assert.equal(out.complete, false);
    assert.deepEqual(contentOf(out).unread, ['7812']);
    assert.ok(contentOf(out).documents.every((d) => d.root !== '7812'));
    assert.match(out.note ?? '', /7812/);
    const unnamed = structuredClone(corpus);
    unnamed.listing = unnamed.listing.filter((root) => root.id !== '7813');
    unnamed.trees['7813'] = unnamed.trees['7813'][0].children;
    const plan = runPlan(unnamed, { roots: corpus.roots });
    const blind = rootsContent({ roots: corpus.roots }, plan.responses);
    assert.equal(blind.content.complete, false);
    assert.deepEqual(blind.untitled, ['7813']);
  });

  test('the tree read of one root is unchanged by the roots read', () => {
    const one = treePlan({ round: 1, external: { key: '7812' }, settings: {} });
    assert.deepEqual(one.requests.map((r) => r.key), ['subtree', 'page-1']);
    const project = treeProject({ external: { key: '7812' }, responses: { subtree: answer(corpus, { route: 'subtree', body: { id: 7812 } }), 'page-1': answer(corpus, { route: 'roots', body: { page: 2 } }) }, original: 'subtree' }) as { artifacts: Array<{ name: string; json: unknown }> };
    assert.deepEqual(project.artifacts.find((a) => a.name === 'meta')?.json, { id: '7812', title: 'COMET' });
  });
});

describe('agile:tree:roots through the connectors', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let agile: AgileStub;
  let slow: StubServer;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['agile-platform']);
    agile = await startAgileStub(caseIndexAgileOptions(corpus));
    // A platform that answers slowly, to see how many requests the read keeps in flight with a generous resource limit.
    const digest = passwordDigest(CASE_INDEX_ACCOUNT.password);
    slow = await startStub((request) => {
      const body = (request.json ?? {}) as { page?: number; id?: unknown; password?: string };
      if (request.path === '/oauth/login/') return body.password === digest ? json({ code: 1000, msg: '', data: { token: 'synthetic-token-0123456789', expire: Math.floor(Date.now() / 1000) + 86400 } }) : json({ code: 1005, msg: '', data: null });
      if (request.headers.authorization !== 'synthetic-token-0123456789') return json({ code: 401, msg: '', data: null });
      if (request.path === '/agile/get_root_node/') return { ...json(listingAnswer(wideCorpus, Number(body.page))), delayMs: 40 };
      if (request.path === '/agile/get_child_node_task/') return { ...json(subtreeAnswer(wideCorpus, String(body.id))), delayMs: 40 };
      return notFound();
    });
  });
  after(async () => {
    await slow?.close();
    await agile?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const wideCorpus: Corpus = (() => {
    const listing = Array.from({ length: 30 }, (_, i) => ({ id: String(9100 + i), label: `根 ${i}` }));
    const trees = Object.fromEntries(listing.map((r) => [r.id, [{ label: '目录', id: `f${r.id}`, cases: [], children: [{ label: `文档 ${r.id}`, id: `d${r.id}`, cases: [], children: [] }] }]]));
    return { ...corpus, listing, trees };
  })();

  async function resource(origin: string, roots: string[], limits?: { concurrency: number }): Promise<string> {
    const added = await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, {
      system_pack: 'agile-platform',
      name: `合成敏捷平台 ${origin}`,
      environment: 'test',
      origins: { 'agile-oauth': origin, 'agile-api': origin },
      allow_plaintext: [origin],
      settings: { roots },
      ...(limits === undefined ? {} : { limits }),
    });
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, added.id, 'username', CASE_INDEX_ACCOUNT.username);
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, added.id, 'password', CASE_INDEX_ACCOUNT.password);
    return added.id;
  }

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: '知识同步' });

  test('the original listing page, the content with every document and its folders, the meta, the revision', async () => {
    const id = await resource(agile.origin, corpus.roots);
    const result = await read('agile:tree:roots');
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    if (!result.ok) return;
    assert.deepEqual(result.artifacts.map((a) => a.name), ['original', 'content', 'meta']);
    const content = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, result.artifacts[1].artifact.body.sha256))) as RootsContent;
    assert.equal(content.complete, true);
    assert.equal(content.documents.length, corpus.truth.length + 1 + corpus.emptyFolders.length, 'the unreadable leaf and the empty folders, besides the truth');
    for (const id of corpus.emptyFolders) assert.equal(content.documents.find((doc) => doc.id === id)?.listed, false, id);
    const truth = new Map(corpus.truth.map((t) => [t.id, t]));
    for (const doc of content.documents) if (truth.has(doc.id)) assert.deepEqual(doc.ancestors, truth.get(doc.id)?.ancestors);
    assert.match(result.revision ?? '', /^[0-9a-f]{64}$/);
    const again = await read('agile:tree:roots');
    assert.ok(again.ok && again.revision === result.revision && again.artifacts[1].artifact.body.sha256 === result.artifacts[1].artifact.body.sha256, 'an unchanged tree gives the same revision and the same stored content');
    assert.equal(agile.requests.filter((r) => r.path === '/agile/get_child_node_task/').length, 6, 'one subtree request per configured root per read');
    assert.ok(agile.requests.every((r) => r.method === 'POST'));
    await kit.connectors.admin.disable(kit.admin, id);
  });

  test('ten roots against a slow platform with a resource limit of 16 keep at most four requests in flight', async () => {
    const roots = wideCorpus.listing.slice(18, 28).map((r) => r.id);
    const id = await resource(slow.origin, roots, { concurrency: 16 });
    slow.reset();
    const result = await read('agile:tree:roots');
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.ok(slow.maxInFlight <= ROOTS_IN_FLIGHT, `at most ${ROOTS_IN_FLIGHT} in flight, saw ${slow.maxInFlight}`);
    assert.ok(slow.maxInFlight >= 2, 'the requests of a round do go out together');
    assert.equal(slow.requests.filter((r) => r.path === '/agile/get_child_node_task/').length, 10);
    await kit.connectors.admin.disable(kit.admin, id);
  });
});
