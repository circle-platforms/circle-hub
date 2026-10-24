// The template-gap pack on the real Hub packages: published through the real pack registry (the publish check), assigned to a
// user, and run by the real run engine on the registry's ports, the real sandbox and a temporary PostgreSQL. A run of this pack
// is a production run: start_run computes and stores the validation result, no submission is needed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RunSummary } from '../../../contracts/src/run.ts';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { createPacksPort, createWorkflowStore, temporaryDirectory, writePack, type StartRunDetail } from '../../../hub/runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { assignedCases, indexView, bindIndex, LOCK, PRODUCT, BUILD, ROOT } from './testing/index.ts';
import { PACK_DIR } from './api.ts';
import { openBed, type Bed } from './testing/bed.ts';
import { baseDocument, bytesOf, outlineDocument, renamed, shuffled, withCase, withoutCategory, witnessCase, type DocumentSpec } from './testing/mindmap.ts';
import { bind, isFailure, projectionInput, sha256, table } from './testing/support.ts';
import { projectDocuments } from './functions/project.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const CATEGORIES = (table('template-v3.json') as { categories: Array<{ id: string }> }).categories.map((category) => category.id);
const skip = (await osIsolationAvailable()) ? false : 'operating-system isolation for pack functions (sandbox-exec) is not available here';

let postgres: TemporaryPostgres;
let bed: Bed;
before(async () => {
  postgres = await startPostgres();
  if (!skip) bed = await openBed(postgres);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

const FOLDERS = ['合成产品线', '030：合成测试项目', '101：10.6.8', '201: 10.6.8-R1-2026/1', '探测'];
/** Puts a synthetic document on the fake agile platform and returns its external id. */
const onAgile = (id: string, doc: DocumentSpec, title = doc.title, on: Bed = bed): string => on.agile.put(id, { bytes: bytesOf(doc), title, folders: FOLDERS });

function requirementOf(result: ValidationResult, item: string): { partition: string; result: ItemResult['requirements'][number] } {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((it) => it.item === item);
    if (found) return { partition, result: found.requirements[0] };
  }
  throw new Error(`item ${item} is in no partition`);
}

async function start(input: Record<string, unknown>, user = bed?.runner, on: Bed = bed): Promise<StartRunDetail> {
  return on.service.startRunDetailed(user, { pack: 'template-gap', product: LOCK.names[0], build: BUILD, ...input } as Parameters<Bed['service']['startRunDetailed']>[1], on.call());
}

describe('publication', { skip }, () => {
  it('the publish check passes on the real registry; the pack is listed for the assigned user only, with the command-catalog product', async () => {
    const outcome = bed.publication;
    assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.problems, null, 1));
    assert.equal(outcome.created, true);
    assert.deepEqual([outcome.version.id, outcome.version.version, outcome.version.kind, outcome.version.withdrawn], ['template-gap', '1.1.3', 'workflow', false]);
    assert.deepEqual([outcome.report.samples.total, outcome.report.samples.passed, outcome.report.unsampled], [13, 13, []]);
    assert.deepEqual(outcome.report.checks.map((c) => [c.check, c.positive, c.negative, c.marks]), [['coverage', 2, 4, ['author_samples_only']], ['command_coverage', 2, 5, ['author_samples_only']]]);
    const store = createWorkflowStore(bed.registry);
    const [summary] = await store.summaries(bed.runner);
    assert.deepEqual([summary.pack, summary.kind, summary.products], ['template-gap@1.1.3', 'workflow', ['Synthetic Template', 'MEADOW']]);
    assert.deepEqual(summary.inputs.map((i) => [i.slot, i.role, i.many, i.required]), [['documents', 'subject', true, true], ['case_index', 'expected', false, false]]);
    assert.deepEqual(summary.requirements.map((r) => [r.key, r.accepted_producer, r.layers, r.done_rule, r.repair_rounds]), [['coverage', 'fact', ['static'], 'bookkeeping', 0], ['command_coverage', 'fact', ['static'], 'bookkeeping', 0]]);
    assert.deepEqual(await store.summaries(bed.stranger), []);
  });

  it('a sample that does not hold refuses the publication', async () => {
    const broken = await openBed(postgres, {
      edit: async (dir) => {
        const path = join(dir, 'samples/positive/coverage-all-covered.json');
        const sample = JSON.parse(await readFile(path, 'utf8'));
        sample.subject.covered = sample.subject.covered.filter((id: string) => id !== 'audit_log');
        await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`);
      },
    });
    try {
      assert.equal(broken.publication.ok, false);
      assert.ok(!broken.publication.ok && broken.publication.problems.some((p) => p.rule === 'publish.sample_failed' && /all_categories_covered/.test(p.message)));
      assert.equal(await broken.registry.getPack('template-gap'), null, 'nothing is half published');
    } finally {
      await broken.close();
    }
  });
});

describe('a production run', { skip }, () => {
  it('one item per document; start_run computes and stores the result; every gap is exactly the removed category, of any group', async () => {
    const base = renamed(baseDocument(), 'r0e2ebase001');
    const upload = await bed.upload(bed.runner, bytesOf(base));
    const removed = CATEGORIES.map((category, k) => ({ category, doc: renamed(withoutCategory(baseDocument(), category), `r0e2egap${String(k).padStart(4, '0')}`), id: `9002${String(k).padStart(2, '0')}` }));
    const restored = renamed(withCase(withoutCategory(baseDocument(), 'audit_log'), '其他', witnessCase('audit_log')), 'r0e2erest001');
    const skippedDoc = renamed(withoutCategory(baseDocument(), 'stress'), 'r0e2eskip001');
    const reason = '用户说这份脑图的功能不涉及性能';
    const documents = [
      { reference: upload },
      ...removed.map((r) => ({ external: onAgile(r.id, r.doc) })),
      { external: onAgile('900301', restored) },
      { external: onAgile('900302', skippedDoc) },
    ];
    // The skip names its document the way the run's sources list it (external id with revision).
    const parameters = { skipped: [{ category: 'stress', reason, document: 'agile:mindmap:900302@1' }] };
    const before = (await bed.service.listRuns(bed.runner)).items.length;
    const detail = await start({ inputs: { documents }, parameters });
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: TRACE }).success);
    const run = RunSummary.parse(detail.answer.run);
    assert.equal((await bed.service.listRuns(bed.runner)).items.length, before + 1);

    // The run locks a catalog-bearing product/root; all requirements are facts, so there are no result slots.
    assert.deepEqual([run.product, run.version, run.build, run.root, run.slots], [PRODUCT, '10.6', BUILD, ROOT, undefined]);
    assert.ok(run.target_basis.length > 0);
    assert.equal(run.instructions, await readFile(join(PACK_DIR, 'SKILL.md'), 'utf8'));
    assert.deepEqual(run.sources.map((s) => [s.role, s.slot, s.external ?? null]), [['subject', 'documents', null], ...removed.map((r) => ['subject', 'documents', `agile:mindmap:${r.id}@1`]), ['subject', 'documents', 'agile:mindmap:900301@1'], ['subject', 'documents', 'agile:mindmap:900302@1']]);

    // The items are what the pack's projection gives in process for the same inputs.
    const meta = (doc: DocumentSpec) => ({ title: doc.title, folders: FOLDERS, found: true });
    const expectedInput = projectionInput(
      [bind(base), ...removed.map((r) => bind(r.doc, { external: `agile:mindmap:${r.id}@1`, meta: meta(r.doc) })), bind(restored, { external: 'agile:mindmap:900301@1', meta: meta(restored) }), bind(skippedDoc, { external: 'agile:mindmap:900302@1', meta: meta(skippedDoc) })],
      parameters,
    );
    const expectedProjection = projectDocuments({ ...expectedInput, context: { ...LOCK, parameters } });
    assert.ok(!isFailure(expectedProjection));
    const expected = expectedProjection.items;
    assert.deepEqual(
      run.items.map((it) => ({ id: it.id, label: it.label, summary: it.summary, fields: it.fields })),
      expected.map((it) => ({ id: it.id, label: it.label, summary: it.summary, fields: it.fields })),
    );
    const uploadId = `upload-${sha256(bytesOf(base)).slice(0, 12)}`;
    assert.equal(run.items[0].id, uploadId);
    assert.equal(run.items[0].location, `src:${sha256(bytesOf(base))}/kityminder@1/n/r0e2ebase001`);
    for (const it of run.items) assert.match(it.digest ?? '', /^[0-9a-f]{64}$/);

    // Production is accepted without a model submission; missing indexed facts remain unknown and named in errors.
    const production = detail.production;
    assert.ok(production !== null);
    const result = ValidationResult.parse(production.result);
    assert.deepEqual([result.acceptance,result.cross_item,result.coverage],['accepted',[],{complete:true,examined:documents.length,total:documents.length}]);
    assert.equal(result.errors.length,documents.length-1);
    assert.ok(result.errors.every(error=>error.code==='missing_input'&&error.requirement==='command_coverage'&&error.item!==undefined&&error.rounds_left===0&&error.path!==undefined&&error.fix?.includes('请求 rec:')));
    assert.deepEqual(production.counts, { delivered: documents.length, rejected: 0, quarantined: 0, incomplete: 0, unknown: documents.length - 1 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));
    assert.equal(production.reference, `rec:${production.record}`);
    // StartRunOutput.result (contracts): the answer names the stored result. Filled by the engine change in progress at the
    // time of writing; whenever the answer carries it, it is this result.
    if (detail.answer.result !== undefined) assert.deepEqual(detail.answer.result, { reference: production.reference, counts: production.counts });
    const view = await bed.service.getRun(bed.runner, run.run);
    assert.deepEqual(view?.latest, { record: production.record, result: production.result }, 'stored at start_run and readable as the run result');
    assert.deepEqual(view?.submissions, [], 'without a submission');

    const pass = (item: string): void => {
      const { partition, result: r } = requirementOf(result, item);
      assert.deepEqual([partition, r.requirement, r.layers, r.status], ['delivered', 'coverage', [{ layer: 'static', terminal: 'pass' }], 'satisfied'], item);
    };
    pass(uploadId);
    pass('900301');
    pass('900302');
    for (const r of removed) {
      const { partition, result: req } = requirementOf(result, r.id);
      assert.equal(partition, 'delivered', 'a gap is delivered content');
      assert.deepEqual(req.layers, [{ layer: 'static', terminal: 'violation', code: 'core.coverage.shortfall', tier: 'advisory', attribution: 'author_input' }], r.category);
      assert.deepEqual([req.status, req.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
      const [claim] = req.claims;
      assert.deepEqual(claim.statement.data?.missing, [r.category], `exactly ${r.category} is missing`);
      assert.deepEqual([claim.qualifier.nature, claim.qualifier.provenance, claim.warrant.producer, claim.warrant.id], ['fact', 'projected', 'function', 'coverage@1']);
      assert.ok(claim.grounds.includes(run.items.find((it) => it.id === r.id)!.location), 'the claim rests on the document');
      const item = run.items.find((it) => it.id === r.id)!;
      assert.deepEqual(item.fields.missing, [r.category]);
      assert.match(item.summary ?? '', new RegExp(`缺 1 个模板类别：[^；]*（${r.category}）`), 'the line the model reads names it');
    }
    const skippedClaim = requirementOf(result, '900302').result.claims[0];
    assert.deepEqual(skippedClaim.statement.data?.skipped, [{ member: 'stress', reason }], 'the skip is listed apart');
    assert.deepEqual(run.items.find((it) => it.id === '900302')?.fields.skipped, [{ category: 'stress', reason }]);
  });

  it('claims that rest on the coverage check carry and show author_samples_only (T02 R[1])', async () => {
    const detail = await start({ inputs: { documents: [{ external: onAgile('900351', renamed(withoutCategory(baseDocument(), 'stress'), 'r0e2emark001')) }] } });
    const [claim] = requirementOf(detail.production!.result, '900351').result.claims;
    assert.ok(claim.qualifier.marks.includes('author_samples_only'), JSON.stringify(claim.qualifier.marks));
  });

  it('the same document in another order gives the identical item, digest included', async () => {
    const base = renamed(baseDocument(), 'r0e2eorder01');
    const first = await start({ inputs: { documents: [{ external: onAgile('900401', base, '顺序') }] } });
    const again = await start({ inputs: { documents: [{ external: onAgile('900401', shuffled(base, 77), '顺序') }] } });
    const [a] = first.answer.run!.items;
    const [b] = again.answer.run!.items;
    assert.notEqual(a.location, b.location, 'other bytes');
    assert.deepEqual({ ...b, location: a.location }, a);
    const claim = (d: StartRunDetail) => d.production!.result.partitions.delivered[0].requirements[0].claims[0].statement;
    assert.deepEqual(claim(again), claim(first));
  });

  it('a commentary submission is optional: accepted as a model judgment, the facts recomputed', async () => {
    const detail = await start({ inputs: { documents: [{ external: onAgile('900501', renamed(withoutCategory(baseDocument(), 'negative'), 'r0e2ecomm001')) }] } });
    const run = detail.answer.run!;
    const answer = await bed.service.submitResult(bed.runner, { run: run.run, model: 'aster-7', items: [], cross_item: [{ nature: 'judgment', statement: '建议补反向用例：缺反向测试', grounds: [run.items[0].location] }] }, bed.call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: TRACE }).success);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    assert.deepEqual(answer.counts, detail.production!.counts);
    const comment = answer.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual([comment.statement.text, comment.qualifier.nature, comment.requirement], ['建议补反向用例：缺反向测试', 'judgment', undefined]);
    assert.deepEqual(requirementOf(answer.result!, '900501').result.layers, requirementOf(detail.production!.result, '900501').result.layers);
    const slots = await bed.service.submitResult(bed.runner, { run: run.run, model: 'aster-7', items: [{ item: '900501', handling: 'handled', slots: { coverage: [] } }] }, bed.call());
    assert.deepEqual(slots.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/coverage']], 'nothing to fill: the Hub computes the fact');
  });
});

describe('refusals at start_run', { skip }, () => {
  it('a document without cases refuses the whole run with the pack fix, and nothing is stored', async () => {
    const runs = (await bed.service.listRuns(bed.runner)).items.length;
    const alone = await start({ inputs: { documents: [{ external: onAgile('900601', outlineDocument()) }] }, parameters: { case_rule: 'tagged' } });
    assert.equal(alone.answer.call_result, 'error');
    assert.ok(StartRunOutput.safeParse({ ...alone.answer, trace: TRACE }).success);
    assert.deepEqual(alone.answer.errors.map((e) => [e.code, e.path]), [['template-gap.no_case', '/inputs/documents']]);
    assert.match(alone.answer.errors[0].message, /900601/);
    assert.match(alone.answer.errors[0].fix ?? '', /打上测试类型标签/);
    const mixed = await start({ inputs: { documents: [{ external: onAgile('900602', renamed(baseDocument(), 'r0e2emix0001')) }, { external: onAgile('900603', outlineDocument('r0e2emix0002')) }] }, parameters: { case_rule: 'tagged' } });
    assert.deepEqual(mixed.answer.errors.map((e) => e.code), ['template-gap.no_case']);
    assert.match(mixed.answer.errors[0].message, /900603/);
    assert.doesNotMatch(mixed.answer.errors[0].message, /900602/);
    assert.equal((await bed.service.listRuns(bed.runner)).items.length, runs);
  });

  it('documents whose roots cannot be told apart are refused with the pack fix', async () => {
    const doc = renamed(baseDocument(), 'r0e2esame001');
    const out = await start({ inputs: { documents: [{ external: onAgile('900701', doc) }, { external: onAgile('900702', shuffled(doc, 3)) }] } });
    assert.deepEqual(out.answer.errors.map((e) => e.code), ['template-gap.root_ambiguous']);
  });

  it('a skip of a category the template does not have is refused by the parameter schema', async () => {
    const out = await start({ inputs: { documents: [{ external: onAgile('900801', renamed(baseDocument(), 'r0e2eparam01')) }] }, parameters: { skipped: [{ category: 'performance', reason: 'x' }] } });
    assert.deepEqual(out.answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/parameters/skipped']]);
  });

  it('a skip the pack cannot apply is refused with the pack fix naming the run’s documents, never dropped', async () => {
    const runs = (await bed.service.listRuns(bed.runner)).items.length;
    const documents = [{ external: onAgile('900811', renamed(withoutCategory(baseDocument(), 'stress'), 'r0e2eskp0001')) }, { external: onAgile('900812', renamed(baseDocument(), 'r0e2eskp0002')) }];
    const elsewhere = await start({ inputs: { documents }, parameters: { skipped: [{ category: 'stress', reason: '不涉及性能', document: 'agile:mindmap:910001' }] } });
    assert.deepEqual(elsewhere.answer.errors.map((e) => e.code), ['template-gap.skip_invalid']);
    assert.match(elsewhere.answer.errors[0].message, /agile:mindmap:910001 不在这次运行里/);
    assert.match(elsewhere.answer.errors[0].fix ?? '', /900811、900812/);
    // U+3000 passes the schema's minLength; it is still no reason.
    const blank = await start({ inputs: { documents }, parameters: { skipped: [{ category: 'stress', reason: '　' }] } });
    assert.deepEqual(blank.answer.errors.map((e) => e.code), ['template-gap.skip_invalid']);
    assert.match(blank.answer.errors[0].message, /没有写理由/);
    const twice = await start({ inputs: { documents }, parameters: { skipped: [{ category: 'stress', reason: '一', document: '900811' }, { category: 'stress', reason: '二', document: '900811@1' }] } });
    assert.deepEqual(twice.answer.errors.map((e) => e.code), ['template-gap.skip_invalid']);
    assert.equal((await bed.service.listRuns(bed.runner)).items.length, runs, 'nothing is stored');
  });

  it('a product outside the required command-catalog products is refused, and a user without the pack gets the neutral answer', async () => {
    const documents = [{ external: onAgile('900901', renamed(baseDocument(), 'r0e2eprod001')) }];
    const named = await start({ inputs: { documents }, product: 'Widget' });
    assert.deepEqual(named.answer.errors.map((e) => [e.code, e.path]), [['REFERENCE_UNRESOLVED', '/product']]);
    const stranger = await start({ inputs: { documents } }, bed.stranger);
    assert.deepEqual(stranger.answer.errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/pack']]);
  });

  it('exposes only catalog-bearing products while another product is active', async () => {
    const withProduct = await openBed(postgres);
    const dir = await temporaryDirectory('circle-hub-template-gap-product-');
    try {
      await writePack(dir.path, { id: 'other-synthetic', version: '1.0.0', kind: 'product', title: '无目录合成产品线', description: '验证无命令目录时不向此工作流暴露产品线', files: { 'product.json': { schema: 'product@1', id: 'other-synthetic', title: '无目录合成产品线', names: ['Other Synthetic'], catalogs: [], producers: [] } } });
      const published = await withProduct.registry.publish(withProduct.owner, dir.path);
      assert.ok(published.ok, JSON.stringify(!published.ok && published.problems));
      await withProduct.registry.activate(withProduct.admin, 'other-synthetic');
      const [summary] = await createWorkflowStore(withProduct.registry).summaries(withProduct.runner);
      const readable = await createPacksPort(withProduct.registry).readableProducts(withProduct.runner);
      const named = await start({ inputs: { documents: [{ external: onAgile('900951', renamed(baseDocument(), 'r0e2eprod002'), undefined, withProduct) }] }, product: 'Other Synthetic' }, withProduct.runner, withProduct);
      assert.deepEqual(
        { products: summary.products, readable: [...readable], errors: named.answer.errors.map((e) => [e.code, e.path]) },
        { products: ['Synthetic Template', 'MEADOW'], readable: [PRODUCT], errors: [['REFERENCE_UNRESOLVED', '/product']] },
      );
    } finally {
      await dir.remove();
      await withProduct.close();
    }
  });
});

describe('a subject builder that fails', { skip }, () => {
  it('leaves the requirement unknown with a check error and the cause in the admin log, never judged as missing input', async () => {
    const failing = await openBed(postgres, {
      edit: async (dir) => {
        const path = join(dir, 'functions/subject.ts');
        const code = await readFile(path, 'utf8');
        const anchor = 'export function coverageSubject(input: unknown): CoverageSubject {';
        assert.ok(code.includes(anchor));
        await writeFile(path, code.replace(anchor, `${anchor}\n  if (input !== undefined) throw new Error('synthetic builder failure');`));
      },
    });
    try {
      assert.ok(failing.publication.ok, JSON.stringify(!failing.publication.ok && failing.publication.problems));
      const ref = await failing.upload(failing.runner, bytesOf(renamed(baseDocument(), 'r0e2ebld0001')));
      const detail = await failing.service.startRunDetailed(failing.runner, { pack: 'template-gap', product: LOCK.names[0], build: BUILD, inputs: { documents: [{ reference: ref }] } }, failing.call());
      const result = detail.production!.result;
      const id = detail.answer.run!.items[0].id;
      const { result: requirement } = requirementOf(result, id);
      const [layer] = requirement.layers;
      assert.deepEqual([layer.terminal, layer.reason], ['unchecked', 'check_error'], JSON.stringify(layer));
      assert.equal(detail.production!.counts.unknown, 1);
      assert.ok(failing.logs.some((entry) => /coverage subject/.test(entry.what)), JSON.stringify(failing.logs.map((entry) => entry.what)));
    } finally {
      await failing.close();
    }
  });
});

describe("the brief's `* -> unknown` row (记未知保留反驳，归责待定)", { skip }, () => {
  it('keeps the refutation as violation and leaves attribution unattributed under `* -> unknown` (记未知保留反驳，归责待定)', async () => {
    const literal = await openBed(postgres, {
      edit: async (dir) => {
        const path = join(dir, 'requirements.json');
        const file = JSON.parse(await readFile(path, 'utf8'));
        file.requirements[0].error_handling = [{ code: '*', action: 'unknown' }];
        await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
      },
    });
    try {
      assert.ok(literal.publication.ok, JSON.stringify(!literal.publication.ok && literal.publication.problems));
      const ref = await literal.upload(literal.runner, bytesOf(renamed(withoutCategory(baseDocument(), 'stress'), 'r0e2elit0001')));
      const detail = await literal.service.startRunDetailed(literal.runner, { pack: 'template-gap', product: LOCK.names[0], build: BUILD, inputs: { documents: [{ reference: ref }] } }, literal.call());
      const production = detail.production!;
      const [item] = production.result.partitions.delivered;
      // 记未知保留反驳，归责待定：终态为 violation、码 core.coverage.shortfall、档 advisory，归责为 unattributed，状态为 unsatisfied，未知计数为 0
      assert.deepEqual(item.requirements[0].layers, [{ layer: 'static', terminal: 'violation', code: 'core.coverage.shortfall', tier: 'advisory', attribution: 'unattributed' }]);
      assert.equal(item.requirements[0].status, 'unsatisfied');
      assert.equal(production.counts.unknown, 0, '记未知不改终态，未知计数为 0');
      assert.equal(item.requirements[0].claims[0].qualifier.nature, 'fact', 'while its claim still says it is a fact');
    } finally {
      await literal.close();
    }
  });
});


it('locks the command catalog and judges both requirements over agile documents and an upload', { skip }, async () => {
  assert.ok(bed.publication.ok, JSON.stringify(!bed.publication.ok && bed.publication.problems));
  const complete = renamed(baseDocument(), 'dual-complete');
  const short = renamed(withoutCategory(baseDocument(), 'audit_log'), 'dual-short');
  const noCommands = renamed(baseDocument(), 'dual-commandless');
  const absent = renamed(baseDocument(), 'dual-absent');
  const before = renamed(baseDocument(), 'dual-before');
  const drift = renamed(before, before.rootId, '修订后的合成脑图标题');
  const maps = [complete, short, noCommands, absent, drift];
  const ids = maps.map((_, i) => `98000${i + 1}`);
  const entries = maps.flatMap((source, i) => i === 3 ? [] : assignedCases(i === 4 ? before : source, ids[i]!, () => i === 2 ? [] : ['CLI/widget/probe']));
  const view = indexView(entries, ids);
  const external = bindIndex(view).external!;
  bed.agile.documents.set(external, { bytes: new TextEncoder().encode(JSON.stringify(view)), title: '合成用例索引', folders: [] });
  const upload = await bed.upload(bed.runner, bytesOf(renamed(baseDocument(), 'dual-upload')));
  const detail = await start({ product: LOCK.names[0], build: BUILD, inputs: { documents: [...maps.map((source, i) => ({ external: onAgile(ids[i]!, source) })), { reference: upload }], case_index: { external } } });
  assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
  assert.equal(detail.answer.run!.root, ROOT);
  assert.match(detail.answer.run!.items.find(item => item.id === ids[3])!.summary ?? '', /文档不在完整索引里.*构建.*重跑/);
  assert.deepEqual(detail.production!.counts, { delivered: 6, rejected: 0, quarantined: 0, incomplete: 0, unknown: 1 });
  for (const item of detail.production!.result.partitions.delivered) {
    const command = item.requirements.find(r => r.requirement === 'command_coverage')!;
    const coverage = item.requirements.find(r => r.requirement === 'coverage')!;
    if (item.item === ids[0]) { assert.equal(coverage.status, 'satisfied'); assert.deepEqual(command.layers, [{ layer: 'static', terminal: 'pass' }]); }
    else if (item.item === ids[1]) { assert.equal(coverage.status, 'unsatisfied'); assert.equal(command.layers[0]!.code, 'template-gap.command_shortfall'); }
    else if (item.item === ids[2]) assert.equal(command.layers[0]!.code, 'template-gap.no_commands');
    else if (item.item === ids[4]) { assert.equal(command.layers[0]!.terminal, 'unchecked'); assert.ok(command.claims.some(c => c.statement.data?.next_action)); }
    else assert.equal(command.layers[0]!.code, 'template-gap.not_indexed');
  }
});

it('runs each paired transitional example through the real registry and engine with bounded recovery', { skip }, async () => {
  const { commandTransitionalExamples } = await import('./testing/command-samples.ts');
  for (const pair of commandTransitionalExamples()) for (const [inputs, sample] of [[pair.inputs, pair.pending], [pair.restored_inputs, pair.restored]] as const) {
    const bytes = new TextEncoder().encode(JSON.stringify(inputs.document));
    const external = bed.agile.put('900001', { bytes, title: inputs.document.root.data.text as string, folders: [] });
    const index = inputs.index ? bindIndex(inputs.index).external! : null;
    if (index) bed.agile.documents.set(index, { bytes: new TextEncoder().encode(JSON.stringify(inputs.index)), title: '合成过渡索引', folders: [] });
    const detail = await start({ inputs: { documents: [{ external }], ...(index ? { case_index: { external: index } } : {}) } });
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const command = detail.production!.result.partitions.delivered[0]!.requirements.find(r => r.requirement === 'command_coverage')!;
    assert.deepEqual(command.claims.map(c => c.statement.verdict), sample.expect.map(e => e.verdict), sample.id);
    for (const claim of command.claims.filter(c => c.statement.verdict === 'unknown')) {
      const data = claim.statement.data!;
      assert.ok((data.missing as unknown[]).length > 0);
      const recovery = data.recovery as { action: string; object: { document: string }; deadline: string; attempts: number };
      assert.ok(recovery.action.includes('重跑')); assert.equal(recovery.object.document, '900001'); assert.match(recovery.deadline, /本轮最终回报前/); assert.equal(recovery.attempts, 1);
    }
  }
});
