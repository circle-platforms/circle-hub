import { labelOf } from '../../contracts/generated/vocabulary.ts';
// Placement by the typed-judgment model (K04) with the scripted judge: a high probability descends level by level, choosing
// none (abstaining) or a probability below the calibrated threshold stops at the parent, an uncalibrated chain places nothing
// below the parent and keeps the answer as a flagged candidate, every judgment is recorded and reused for unchanged input,
// and code-placed spans become masked calibration samples.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { NONE_OPTION, SCRIPTED_MODEL, ScriptedJev, type JevJudgmentRecord, type ScriptedAnswer } from '../jev/api.ts';
import type { ActionBody } from '../records/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { PLACEMENT_CHAIN } from './calibration.ts';
import { formatSyncReport } from './cli.ts';
import { syncProduct } from './sync.ts';
import { INDEX, ProduceDetail } from './store.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, DEFAULT_SYNC, catalogXml, extraProducer, makeWorld, standardSite, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const PRODUCERS = [
  DEFAULT_PRODUCERS[0],
  { id: 'manual', title: '手册', function: { module: 'functions/manual.ts' }, inputs: { manual: { external: 'store:manual:{product}-{line}' } }, placement: 'judgment_allowed' as const },
];

const MANUAL = [
  '# Manual',
  '',
  '## Restart',
  '',
  'Use the commands of system reboot to restart the unit after a delay.',
  '',
  '## Odd',
  '',
  '[abstain] The commands of system keep their state between restarts.',
  '',
  '## Echo',
  '',
  '[low] The commands of net ping send echo requests to a host.',
  '',
  '## Other',
  '',
  'Nothing in this paragraph names a known place.',
  '',
].join('\n');

/** Picks the option named in the passage; [abstain] chooses none under /commands/system; [low] answers 0.6 under /commands/net. */
const judge: ScriptedAnswer = (question, state, id) => {
  const piece = (state as Record<string, { text: string }>)[id];
  const text = piece.text.toLowerCase();
  if (question.type !== 'choice') return { noul: 0.5 };
  if (text.includes('[abstain]') && question.instructions.includes('node /commands/system,')) return { choice: NONE_OPTION, p: 0.9 };
  const hit = Object.keys(question.criteria).find((option) => option !== NONE_OPTION && new RegExp(`\\b${option}\\b`).test(text));
  if (hit === undefined) return { choice: NONE_OPTION, p: 0.9 };
  return { choice: hit, p: text.includes('[low]') && question.instructions.includes('node /commands/net,') ? 0.6 : 0.97 };
};

const build: KnownBuild = {
  name: 'Rel_ACME_1_2_15',
  family: 'ACME',
  line: '1.2',
  base: 'Rel_ACME_1_2_15',
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: 'site:tree:Rel_ACME_1_2_15' },
  root: null,
};

async function setup(t: { after: (fn: () => Promise<void>) => void }, calibrated: boolean): Promise<{ w: World; jev: ScriptedJev }> {
  const jev = new ScriptedJev(judge);
  const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: PRODUCERS } } });
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  w.external.set('store:manual:acme-1.2', { bytes: MANUAL, mediaType: 'text/markdown' });
  if (calibrated) {
    const samples = Array.from({ length: 80 }, (_, i) => ({ input: i.toString(16).padStart(64, '0'), expected: 'x', chosen: 'x', probability: 0.97 }));
    await w.knowledge.calibration.addLabelled(w.admin, { kind: PLACEMENT_CHAIN, model: SCRIPTED_MODEL, samples });
  }
  return { w, jev };
}

async function compositionOf(w: World, digest: string) {
  const record = await w.kit.store.get(digest);
  return TreeRootBody.parse(record?.body);
}

describe('placement by the typed-judgment model', () => {
  test('calibrated: high probability descends, none and low probability stop at the parent, nothing named stays unplaced', async (t) => {
    const { w, jev } = await setup(t, true);
    assert.equal(await w.knowledge.calibration.threshold(PLACEMENT_CHAIN, SCRIPTED_MODEL), 0.97);
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.placedByModel, 3);
    assert.equal(result.unplaced, 1);
    const body = await compositionOf(w, result.composition as string);
    const placed = Object.fromEntries(body.composition.filter((row) => row.placement !== undefined).map((row) => [row.path, row.placement]));
    assert.deepEqual(Object.keys(placed).sort(), ['/commands/net', '/commands/system', '/commands/system/reboot']);
    assert.equal(placed['/commands/system/reboot']?.judgments.length, 3);
    assert.equal(placed['/commands/system/reboot']?.note, `归类判断：Jev@${SCRIPTED_MODEL}，p=0.97，只影响位置`);
    assert.match(placed['/commands/system']?.note ?? '', /弃权.*停在 \/commands\/system/);
    assert.match(placed['/commands/net']?.note ?? '', /p=0\.60 低于本链的校准阈值 0\.97，停在 \/commands\/net/);
    const [unplaced] = body.unplaced;
    assert.equal(unplaced.stopped_at, '/');
    assert.equal(unplaced.candidate, null);
    assert.match(unplaced.note, /都不合适/);

    // Every question asked is a classify action with the exact model, the question, the candidates, the input digest and probabilities.
    const actions = (await w.kit.store.find<ActionBody>({ key: INDEX.actionKind, value: 'classify', kind: 'action', limit: 100 })).items;
    assert.equal(actions.length, 3 + 3 + 3 + 1);
    const judgment = (actions[0].body.detail as { judgment: JevJudgmentRecord }).judgment;
    assert.equal(judgment.exact_model, SCRIPTED_MODEL);
    assert.equal(judgment.question_type, 'choice');
    assert.equal(judgment.candidates[judgment.candidates.length - 1].name, NONE_OPTION);
    assert.match(judgment.input_digest, /^[0-9a-f]{64}$/);
    assert.ok(judgment.reuse_key !== null);
    assert.equal(Object.keys(judgment.probabilities).length, judgment.candidates.length);
    assert.equal(jev.requests.length, 3, 'one request per level: the independent questions of a level are batched');

    // The note is shown with the entry: placement only moves it.
    const node = await w.knowledge.getNodes({ root: result.root as string, paths: ['/commands/system/reboot'], depth: 0 }, w.user);
    const manual = node?.nodes[0].entries.find((e) => typeof e.data?.section === 'string');
    assert.equal(manual?.applicability, `未声明；归类判断：Jev@${SCRIPTED_MODEL}，p=0.97，只影响位置`);
  });

  test('an unchanged input reuses the recorded judgments: producing again asks nothing and gives the same root', async (t) => {
    const { w, jev } = await setup(t, true);
    const first = await w.knowledge.produceTree({ product: w.product, build });
    const asked = jev.requests.length;
    const again = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(again.root, first.root);
    assert.equal(jev.requests.length, asked, 'no new request for unchanged input');
    // A changed span is asked again.
    w.external.set('store:manual:acme-1.2', { bytes: MANUAL.replace('after a delay', 'after a long delay'), mediaType: 'text/markdown' });
    const changed = await w.knowledge.produceTree({ product: w.product, build });
    assert.ok(jev.requests.length > asked);
    assert.notEqual(changed.root, first.root);
  });

  test('uncalibrated: nothing is placed below the parent; the answer is kept as a candidate flagged uncalibrated', async (t) => {
    const { w } = await setup(t, false);
    assert.equal(await w.knowledge.calibration.threshold(PLACEMENT_CHAIN, SCRIPTED_MODEL), null);
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.placedByModel, 0);
    assert.equal(result.unplaced, 4);
    const body = await compositionOf(w, result.composition as string);
    const named = body.unplaced.filter((row) => row.candidate !== null);
    assert.equal(named.length, 3);
    for (const row of named) {
      assert.equal(row.stopped_at, '/');
      assert.deepEqual(row.candidate, { path: '/commands', model: SCRIPTED_MODEL, p: 0.97, calibrated: false });
      assert.match(row.note, /本链尚未校准/);
      assert.match(row.note, /^归类判断：Jev@jev-scripted-1\.0\.0，p=0\.97，只影响位置/);
    }
    // The uncalibrated answers never enter the tree: the root equals the tree of the commands alone.
    const plain = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0]] } } });
    t.after(() => plain.close());
    plain.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    assert.equal((await plain.knowledge.produceTree({ product: plain.product, build })).root, result.root);
  });

  test('a sync places again after a judge failure and after the chain is calibrated, and skips otherwise', async (t) => {
    let failing = true;
    const jev = new ScriptedJev((question, state, id) => (failing ? { fail: 'JEV_UNAVAILABLE' } : judge(question, state, id)));
    const optional = [DEFAULT_PRODUCERS[0], { ...PRODUCERS[1], inputs: { manual: { external: 'store:manual:{product}-{line}', optional: true } } }];
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: optional } } });
    t.after(() => w.close());
    standardSite(w.external);
    w.external.set('store:manual:acme-1.2', { bytes: MANUAL, mediaType: 'text/markdown' });
    const reasonOf = (report: Awaited<ReturnType<World['knowledge']['syncProduct']>>) => report.builds.find((b) => b.name === 'Rel_ACME_1_2_15');

    const first = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    assert.equal(reasonOf(first)?.outcome, 'produced');
    assert.equal(reasonOf(first)?.unplaced, 4);
    const failedRoot = reasonOf(first)?.root;

    failing = false;
    const second = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    assert.equal(reasonOf(second)?.outcome, 'produced');
    assert.match(reasonOf(second)?.reason ?? '', /重新产出：上次有 4 个片段的归位判断失败/);
    assert.equal(reasonOf(second)?.root, failedRoot, 'uncalibrated answers do not change the tree');

    const third = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    assert.equal(reasonOf(third)?.outcome, 'skipped');

    const samples = Array.from({ length: 80 }, (_, i) => ({ input: i.toString(16).padStart(64, '0'), expected: 'x', chosen: 'x', probability: 0.97 }));
    await w.knowledge.calibration.addLabelled(w.admin, { kind: PLACEMENT_CHAIN, model: SCRIPTED_MODEL, samples });
    const fourth = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    assert.equal(reasonOf(fourth)?.outcome, 'produced');
    assert.match(reasonOf(fourth)?.reason ?? '', /重新产出：归位的模型或本链的校准变了/);
    assert.notEqual(reasonOf(fourth)?.root, failedRoot);
    assert.equal(reasonOf(fourth)?.unplaced, 1);
    assert.equal(fourth.pointers.find((p) => p.line === '1.2')?.moved, true, 'the line moves to the newly placed tree');
  });

  test('the placement API directly: a tie stops at the parent; more than 254 children are narrowed by literal match first', async (t) => {
    const wide = Array.from({ length: 300 }, (_, i) => ({ name: `item${i}`, description: null }));
    const tree = {
      children: (segments: readonly string[]) =>
        segments.length === 0 ? [{ name: 'alpha', description: 'first' }, { name: 'beta', description: 'second' }] : segments.length === 1 && segments[0] === 'alpha' ? wide : [],
    };
    const asked: number[] = [];
    const jev = new ScriptedJev((question, state, id) => {
      const text = (state as Record<string, { text: string }>)[id].text;
      if (question.type !== 'choice') return { noul: 0.5 };
      const options = Object.keys(question.criteria);
      asked.push(options.length);
      if (text.includes('tie')) return { probabilities: { alpha: 0.45, beta: 0.45, [NONE_OPTION]: 0.1 } };
      const hit = options.find((o) => o !== NONE_OPTION && text.includes(o));
      return hit === undefined ? { choice: NONE_OPTION, p: 0.9 } : { choice: hit, p: 0.99 };
    });
    const w = await makeWorld(postgres, { jev });
    t.after(() => w.close());
    const spans = [
      { key: 'a'.repeat(64), text: 'a tie between both', section: '', fragment: `src:${'1'.repeat(64)}` },
      { key: 'b'.repeat(64), text: 'about alpha and its item7', section: '', fragment: `src:${'2'.repeat(64)}` },
      { key: 'c'.repeat(64), text: 'about alpha only', section: '', fragment: `src:${'3'.repeat(64)}` },
    ];
    const outcomes = await w.knowledge.placement.place(spans, tree, { threshold: 0.9, context: { product: 'acme' } });
    const tie = outcomes.get('a'.repeat(64));
    assert.equal(tie?.placed, false);
    assert.match(tie?.note ?? '', /最高的两个选项概率相同，停在 \//);
    const narrowed = outcomes.get('b'.repeat(64));
    assert.deepEqual(narrowed?.segments, ['alpha', 'item7']);
    assert.equal(narrowed?.placed, true);
    // item7 alone matched among 300 children (plus none): a question the service can take.
    assert.ok(asked.includes(2));
    const tooMany = outcomes.get('c'.repeat(64));
    assert.deepEqual(tooMany?.segments, ['alpha']);
    assert.match(tooMany?.note ?? '', /可选子节点有 300 个/);
    assert.ok(asked.every((n) => n <= 255));
  });

  test('code-placed spans become calibration samples with their command literals masked', async (t) => {
    const { w } = await setup(t, false);
    const result = await w.knowledge.produceTree({ product: w.product, build });
    const built = await w.knowledge.calibration.buildCalibrationSet({ root: result.root as string, kinds: ['definition'], by: w.admin });
    // Four commands, three levels each; with the literals masked the scripted judge finds no name to pick.
    assert.equal(built.samples, 12);
    assert.ok(built.record !== null);
    const record = await w.kit.store.get(built.record as string);
    const body = record?.body as { origin: string; root: string; samples: Array<{ expected: string; chosen: string }> };
    assert.equal(body.origin, 'projected');
    assert.equal(body.root, result.root);
    assert.ok(body.samples.every((s) => s.chosen === NONE_OPTION && s.expected !== NONE_OPTION));
    assert.equal(built.state?.threshold, null, 'twelve wrong answers do not calibrate the chain');
    assert.equal(built.state?.samples, 12);
    await assert.rejects(w.knowledge.calibration.buildCalibrationSet({ root: result.root as string, by: w.user }), /只有管理员/);
    await assert.rejects(w.knowledge.calibration.addLabelled(w.user, { kind: PLACEMENT_CHAIN, model: SCRIPTED_MODEL, samples: [] }), /只有管理员/);
  });

  test('a calibration question never shows the sampled entry itself; nodes with entries and children ask for none too', async (t) => {
    // A judge that only matches <...> tokens between the passage and an option's description.
    const tokens = (text: string) => new Set(text.match(/<[^>]+>/g) ?? []);
    const jev = new ScriptedJev((question, state, id) => {
      if (question.type !== 'choice') return { noul: 0.5 };
      const seen = tokens((state as Record<string, { text: string }>)[id].text);
      const hit = Object.entries(question.criteria).find(([option, description]) => option !== NONE_OPTION && description !== null && [...tokens(description)].some((token) => seen.has(token)));
      return hit === undefined ? { choice: NONE_OPTION, p: 0.9 } : { choice: hit[0], p: 0.99 };
    });
    const commands = Array.from({ length: 80 }, (_, i) => ({ name: `cmd${i.toString(16)}`, params: [{ name: `arg${i.toString(16)}`, type: 'int' as const }], help: `help text ${i}` }));
    const inner = { kind: 'definition', path: '/commands/grp0', statement: 'the group of commands', data: {}, fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }], applicability: null };
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: [{ ...DEFAULT_PRODUCERS[0], params: { extra: [inner] } }] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml({ grp0: commands }), mediaType: 'application/xml' });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    const built = await w.knowledge.calibration.buildCalibrationSet({ root: result.root as string, by: w.admin, limit: 500 });
    const record = await w.kit.store.get(built.record as string);
    const samples = (record?.body as { samples: Array<{ expected: string; chosen: string }> }).samples;
    // 80 commands at three levels, plus the group's own entry at the two levels above it and at itself (where none is right).
    assert.equal(built.samples, 80 * 3 + 3);
    assert.equal(samples.filter((s) => s.expected === NONE_OPTION).length, 1);
    assert.equal(samples.filter((s) => s.chosen !== NONE_OPTION).length, 0, 'the masked passage matches no description');
    assert.equal(built.state?.threshold, null, 'nothing leaked, so nothing calibrates');
  });

  test('descriptions are cut on characters: a pair split at the cut never makes a question the service refuses', async (t) => {
    const odd = { kind: 'definition', path: '/commands/system/odd', statement: `${'a'.repeat(159)}\u{1F600} and more`, data: {}, fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }], applicability: null };
    const jev = new ScriptedJev(judge);
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: [{ ...PRODUCERS[0], params: { extra: [odd] } }, PRODUCERS[1]] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    w.external.set('store:manual:acme-1.2', { bytes: MANUAL, mediaType: 'text/markdown' });
    const samples = Array.from({ length: 80 }, (_, i) => ({ input: i.toString(16).padStart(64, '0'), expected: 'x', chosen: 'x', probability: 0.97 }));
    await w.knowledge.calibration.addLabelled(w.admin, { kind: PLACEMENT_CHAIN, model: SCRIPTED_MODEL, samples });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    const body = await compositionOf(w, result.composition as string);
    const placed = body.composition.filter((row) => row.placement !== undefined).map((row) => row.path).sort();
    assert.ok(placed.includes('/commands/system/reboot'), placed.join(' '));
    for (const row of [...body.composition, ...body.unplaced]) {
      const note = 'note' in row ? row.note : (row.placement?.note ?? '');
      assert.doesNotMatch(note ?? '', /JevError|不合格/);
    }
  });

  test('a question that cannot be asked fails only itself, is counted failed and keeps its detail out of the note', async (t) => {
    const jev = new ScriptedJev((question, state, id) => {
      if (question.type !== 'choice') return { noul: 0.5 };
      return { choice: 'alpha', p: 0.99 };
    });
    const w = await makeWorld(postgres, { jev });
    t.after(() => w.close());
    const tree = { children: (segments: readonly string[]) => (segments.length === 0 ? [{ name: 'alpha', description: 'first' }, { name: 'beta', description: 'second' }] : []) };
    const spans = [
      { key: 'a'.repeat(64), text: 'about alpha', section: '', fragment: `src:${'1'.repeat(64)}` },
      { key: 'b'.repeat(64), text: 'broken \ud83d text', section: '', fragment: `src:${'2'.repeat(64)}` },
    ];
    const problems: string[] = [];
    const outcomes = await w.knowledge.placement.place(spans, tree, { threshold: 0.9, context: { product: 'acme' }, onProblem: (text) => void problems.push(text) });
    assert.deepEqual(outcomes.get('a'.repeat(64))?.segments, ['alpha']);
    assert.equal(outcomes.get('a'.repeat(64))?.placed, true);
    const broken = outcomes.get('b'.repeat(64));
    assert.equal(broken?.placed, false);
    assert.equal(broken?.failed, true);
    assert.doesNotMatch(broken?.note ?? '', /JevError|不成对/);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /不成对的代理字符/);
  });

  test('a probability just below the threshold is shown with enough digits to see the order', async (t) => {
    const jev = new ScriptedJev((question) => (question.type !== 'choice' ? { noul: 0.5 } : { probabilities: { alpha: 0.9601, beta: 0.0299, [NONE_OPTION]: 0.01 } }));
    const w = await makeWorld(postgres, { jev });
    t.after(() => w.close());
    const tree = { children: (segments: readonly string[]) => (segments.length === 0 ? [{ name: 'alpha', description: null }, { name: 'beta', description: null }] : []) };
    const outcomes = await w.knowledge.placement.place([{ key: 'c'.repeat(64), text: 'about alpha', section: '', fragment: `src:${'3'.repeat(64)}` }], tree, { threshold: 0.965, context: { product: 'acme' } });
    const note = outcomes.get('c'.repeat(64))?.note ?? '';
    assert.match(note, /p=0\.960 低于本链的校准阈值 0\.965/);
  });
});

describe('producer opt-in for typed judgment placement (data exfiltration safeguard)', () => {
  test('an undeclared producer producing path-less entries never sends any spans to the judgment service', async (t) => {
    const receivedPieces: string[] = [];
    const jev = new ScriptedJev((question, state, id) => {
      const piece = (state as Record<string, { text: string }>)[id];
      receivedPieces.push(piece?.text ?? id);
      return { choice: NONE_OPTION, p: 0.9 };
    });
    const unplacedDefect = {
      kind: 'defect',
      path: null,
      statement: 'Bug #1234: internal crash in worker thread',
      data: { bug: 1234 },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const unopted = extraProducer('defects', { entries: [unplacedDefect] });
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], unopted] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });

    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(receivedPieces.length, 0, 'no span sent to the judge');
    assert.equal(result.placedByModel, 0);
    assert.equal(result.unplaced, 1);
    assert.deepEqual(result.placementSkipped, { defects: 1 });

    const action = await w.kit.store.get<ActionBody>(result.action as string);
    const detail = ProduceDetail.parse(action?.body.detail);
    assert.equal(detail.placement?.spans, 0);
    assert.deepEqual(detail.placement?.skipped, { defects: 1 });

    const body = await compositionOf(w, result.composition as string);
    assert.equal(body.unplaced.length, 1);
    const [row] = body.unplaced;
    assert.equal(row.stopped_at, '/');
    assert.equal(row.candidate, null);
    assert.deepEqual(row.judgments, []);
    assert.equal(row.note, '生产器未声明交给 bot 归位，留在根下标为未归位');
    assert.deepEqual(row.producers, ['defects']);
  });

  test('an opted-in producer (placement: judgment_allowed) hands its path-less spans to the injected judge', async (t) => {
    const receivedPieces: string[] = [];
    const jev = new ScriptedJev((question, state, id) => {
      const piece = (state as Record<string, { text: string }>)[id];
      receivedPieces.push(piece?.text ?? id);
      return { choice: NONE_OPTION, p: 0.9 };
    });
    const manualSpan = {
      kind: 'definition',
      path: null,
      statement: 'Manual passage describing net ping command',
      data: {},
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const opted = extraProducer('manual', { entries: [manualSpan] }, { tree: { source: 'tree' } }, 'judgment_allowed');
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], opted] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });

    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(receivedPieces.length, 1);
    assert.equal(receivedPieces[0], 'Manual passage describing net ping command');
    assert.equal(result.placementSkipped, undefined);

    const action = await w.kit.store.get<ActionBody>(result.action as string);
    const detail = ProduceDetail.parse(action?.body.detail);
    assert.equal(detail.placement?.spans, 1);
    assert.equal(detail.placement?.skipped, undefined);
  });

  test('mixed producers: only opted-in producers spans are sent, un-opted stay unplaced and are counted skipped', async (t) => {
    const receivedPieces: string[] = [];
    const jev = new ScriptedJev((question, state, id) => {
      const piece = (state as Record<string, { text: string }>)[id];
      receivedPieces.push(piece?.text ?? id);
      return { choice: NONE_OPTION, p: 0.9 };
    });
    const defect1 = {
      kind: 'defect',
      path: null,
      statement: 'Bug #101: worker timeout on large files',
      data: { bug: 101 },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const defect2 = {
      kind: 'defect',
      path: null,
      statement: 'Bug #102: memory leak in parser cache',
      data: { bug: 102 },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const manual1 = {
      kind: 'definition',
      path: null,
      statement: 'Manual section for system show info',
      data: {},
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const manual2 = {
      kind: 'definition',
      path: null,
      statement: 'Manual section for network status ping',
      data: {},
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const unopted = extraProducer('defects', { entries: [defect1, defect2] });
    const opted = extraProducer('manual', { entries: [manual1, manual2] }, { tree: { source: 'tree' } }, 'judgment_allowed');
    const w = await makeWorld(postgres, { jev, pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], unopted, opted] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });

    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(receivedPieces.length, 2);
    assert.ok(receivedPieces.includes('Manual section for system show info'));
    assert.ok(receivedPieces.includes('Manual section for network status ping'));
    assert.ok(!receivedPieces.some((text) => text.includes('Bug #101') || text.includes('Bug #102')), 'defects are never sent to judgment');
    assert.deepEqual(result.placementSkipped, { defects: 2 });

    const action = await w.kit.store.get<ActionBody>(result.action as string);
    const detail = ProduceDetail.parse(action?.body.detail);
    assert.equal(detail.placement?.spans, 2);
    assert.deepEqual(detail.placement?.skipped, { defects: 2 });

    const body = await compositionOf(w, result.composition as string);
    const defectRows = body.unplaced.filter((r) => r.producers.includes('defects'));
    assert.equal(defectRows.length, 2);
    for (const row of defectRows) {
      assert.equal(row.stopped_at, '/');
      assert.equal(row.candidate, null);
      assert.deepEqual(row.judgments, []);
      assert.equal(row.note, '生产器未声明交给 bot 归位，留在根下标为未归位');
    }
  });

  test('without a placer, the declared and the undeclared path-less entries both stay unplaced at the root', async (t) => {
    const unplacedDefect = {
      kind: 'defect',
      path: null,
      statement: 'Bug #201: crash on null pointer',
      data: { bug: 201 },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const manualSpan = {
      kind: 'definition',
      path: null,
      statement: 'Manual note on reboot',
      data: {},
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const unopted = extraProducer('defects', { entries: [unplacedDefect] });
    const opted = extraProducer('manual', { entries: [manualSpan] }, { tree: { source: 'tree' } }, 'judgment_allowed');
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], unopted, opted] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });

    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.unplaced, 2);
    assert.deepEqual(result.placementSkipped, { defects: 1 });

    const body = await compositionOf(w, result.composition as string);
    const defectRow = body.unplaced.find((r) => r.producers.includes('defects'));
    assert.equal(defectRow?.note, '生产器未声明交给 bot 归位，留在根下标为未归位');
    const manualRow = body.unplaced.find((r) => r.producers.includes('manual'));
    assert.equal(manualRow?.note, '未归位，留在根下');
  });

  test('the sync report says how many entries stay unplaced at the root, and keeps the per-producer counts as data', async (t) => {
    const defect = {
      kind: 'defect',
      path: null,
      statement: 'Bug #501: defect description',
      data: { bug: 501 },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
      applicability: null,
    };
    const unopted = extraProducer('defects', { entries: [defect] });
    const w = await makeWorld(postgres, { pack: { declaration: { sync: DEFAULT_SYNC, producers: [DEFAULT_PRODUCERS[0], unopted] } } });
    t.after(() => w.close());
    standardSite(w.external);

    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    assert.equal(report.counts.produced, 1);
    const buildReport = report.builds[0];
    assert.ok(buildReport.reason.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 1 个，留在根下'));
    assert.doesNotMatch(buildReport.reason, /判断服务|模型归类/);
    assert.deepEqual(buildReport.placement_skipped, { defects: 1 });
    const formatted = formatSyncReport(report);
    assert.ok(formatted.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 1 个，留在根下'));
    assert.doesNotMatch(formatted, /判断服务|模型归类/);
  });
});
