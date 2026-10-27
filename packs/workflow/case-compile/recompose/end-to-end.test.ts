import { assembleRecompose } from '../tools/seal-recompose.ts';
import { fixture as blockFixture, plan as blockPlan, call as blockCall } from '../testing/blocks.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { satisfiedRecipe } from '../tools/generate-workbook.ts';
import { generateWorkbook } from '../functions/generate.ts';
// The real run engine, registry, record reader and sandboxes; all systems and model decisions are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startPostgres } from '../../../../hub/testing/postgres.ts';
import { temporaryDirectory, writePack } from '../../../../hub/runs/api.ts';
import { jsonParser } from '../../../../hub/refs/api.ts';
import { createCatalogView } from '../../../../hub/rules/api.ts';
import { INDEX } from '../../../../hub/runs/engine/store.ts';
import { openHub, call } from '../testing/hub.ts';
import { stageRecompose } from '../testing/stage-recompose.ts';
import { fixture as unitFixture } from '../testing/recompose.ts';
import { fixtureJson, fixtureText } from '../../../../tests/fixtures/recompose/index.ts';
import { admittedRecomposition } from '../functions/recomposition.ts';
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
test('a product publication, genuine independent adjudication and append-only recomposition admit one complete artifact', async () => {
    const postgres = await startPostgres(), temp = await temporaryDirectory('recompose-e2e-');
    let h: Awaited<ReturnType<typeof openHub>> | undefined;
    try {
        h = await openHub(postgres);
        const f = unitFixture(), build = { name: 'Rel_ORBIT_10_8_0_30', family: 'ORBIT', line: '10.8', base: 'Rel_ORBIT_10_8_0_30', platform: null, built_at: null, released_at: null, sources: {}, root: f.context.root }, info = { root: f.context.root, composition: sha('synthetic composition'), product: 'orbit', build, produced_at: '2026-10-27T00:00:00Z', command_policy: { schema: 'command-policy@1' as const, read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/widget', inverse_prefix: '/commands/no/widget', leading_parameters: 1 }] } };
        h.knowledge.builds = async () => [build];
        h.knowledge.resolveBuild = async () => build;
        h.knowledge.currentRoot = async () => info;
        h.knowledge.rootOfBuild = async () => info;
        h.knowledge.rootInfo = async () => [info];
        h.knowledge.catalog = async () => createCatalogView(f.catalog.entries, { reference: 'tree:' + build.root + '/commands', complete: true, caseSensitive: true });
        const productDir = (await writePack(join(temp.path, 'product'), { id: 'orbit', version: '1.0.0', kind: 'product', title: 'ORBIT / COMET', description: 'synthetic source authority', files: { 'product.json': { schema: 'product@1', id: 'orbit', title: 'ORBIT', names: ['ORBIT', 'COMET'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: true }], producers: [{ id: 'declarations', title: 'Synthetic declarations', function: { module: 'functions/declarations.ts' }, inputs: {}, params: { recompose: fixtureJson('product-policy.json') } }] }, 'functions/declarations.ts': 'export default function(){return {entries:[],notes:[]};}' } })).dir;
        const product = await h.registry.publish(h.alice, productDir);
        assert.equal(product.ok, true, JSON.stringify(product));
        if (!product.ok)
            return;
        await h.registry.activate(h.admin, 'orbit');
        for (const folder of ['authority', 'recompose', 'adjudicate']) {
            const published = await h.registry.publish(h.alice, await stageRecompose(folder, join(temp.path, folder)));
            assert.equal(published.ok, true, JSON.stringify(published));
            if (!published.ok)
                return;
            for (const user of [h.admin, h.alice, h.bob])
                await h.registry.assign(h.admin, user.id, published.version.id);
        }
        const put = (id: string, bytes: Uint8Array | string) => h!.external.put(id, { bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes, mediaType: 'application/json' });
        put('doc:doc:synthetic-product', await readFile(join(productDir, 'product.json')));
        const start = { product: 'orbit', build: build.name }, auth = await h.service.startRunDetailed(h.admin, { ...start, pack: 'recompose-authority', inputs: { product_data: { external: 'doc:doc:synthetic-product' }, product_version: { reference: 'rec:' + product.version.record }, publication: { reference: 'rec:' + product.version.publication } } }, call());
        assert.equal(auth.answer.call_result, 'ok', JSON.stringify(auth.answer.errors));
        assert.ok(auth.production);
        const authorityRun = auth.answer.run!;
        assert.equal(authorityRun.requirements[0].key, 'authority');
        assert.ok(auth.production!.result.cross_item.some(c => c.requirement === 'authority' && c.statement.verdict === 'support'), JSON.stringify(auth.production));
        const authRecord = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: authorityRun.run })).items[0], authResult = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: authorityRun.run, newestFirst: true })).items[0];
        await h.kit.authorizations.share(h.admin, authorityRun.run, [h.alice.id]);
        const external = 'agile:mindmap:synthetic-recompose', source = fixtureText('author-pass.km.json');
        put(external, source);
        const evidenceNames = ['governing-spec.json', 'conflicting-spec.json', 'declarations.json'];
        for (const name of evidenceNames)
            put('doc:doc:' + name, fixtureText(name));
        const inputs = { subject: { external }, authority_run: { reference: 'rec:' + authRecord.digest }, authority_result: { reference: 'rec:' + authResult.digest }, evidence: evidenceNames.map(name => ({ external: 'doc:doc:' + name })) };
        const first = await h.service.startRunDetailed(h.alice, { ...start, pack: 'recompose', inputs, parameters: { case_depths: [1] } }, call());
        assert.equal(first.answer.call_result, 'ok', JSON.stringify(first.answer.errors));
        const original = first.answer.run!;
        const record = fixtureJson('recompose-pass.json'), quotes = record.atoms.map((a: any) => ({ reference: a.quote_ref, text: a.text }));
        for (const name of evidenceNames) {
            const bytes = fixtureText(name);
            quotes.push({ reference: 'src:' + sha(bytes), text: bytes });
            if (name === 'declarations.json') {
                const ref = record.ledgers.adapted[0].equivalence_refs[0];
                quotes.push({ reference: ref, text: (await jsonParser.parse(Buffer.from(bytes), {}).locate('p/parameters/0'))!.text! });
            }
        }
        const submit = (run: string, item: string, data: any) => ({ run, model: 'scripted-recomposer', items: [{ item, handling: 'handled' as const, slots: { record: [{ text: '合成重组判断', quotes, data }] } }] });
        const draft = await h.service.submitResult(h.alice, submit(original.run, original.items[0].id, record), call());
        assert.equal(draft.acceptance, 'accepted', JSON.stringify(draft.errors));
        assert.ok(Object.values(draft.result!.partitions).flat().some(i => i.requirements.some(r => r.status !== 'satisfied')));
        const submission = (await h.kit.store.find({ kind: 'submission', key: INDEX.submissionRun, value: original.run })).items[0];
        await h.kit.authorizations.share(h.admin, original.run, [h.bob.id]);
        const review = await h.service.startRunDetailed(h.bob, { pack: 'recompose-adjudication', predecessor: original.run, inputs: { source_run: { reference: 'rec:' + (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: original.run })).items[0].digest }, declaration: { reference: 'rec:' + submission.digest }, evidence: [{ external }, ...inputs.evidence] } }, call());
        assert.equal(review.answer.call_result, 'ok', JSON.stringify(review.answer.errors));
        const reviewed = await h.service.submitResult(h.bob, { run: review.answer.run!.run, model: 'scripted-independent-model', items: review.answer.run!.items.map(i => ({ item: i.id, handling: 'handled', slots: { decision: [{ text: '合成独立原子裁定', code: 'accept', location: i.location, quotes: [i.fields.quote as any], data: { atom: String(i.fields.atom), state: 'settled', load_bearing: i.fields.atom === 'a1', bed_independent: true, reason: '按真实原文与声明位置核对合成语义' } }] } })) }, call());
        assert.equal(reviewed.acceptance, 'accepted', JSON.stringify(reviewed.errors));
        assert.ok(Object.values(reviewed.result!.partitions).flat().every(i => i.requirements.every(r => r.status === 'satisfied')), JSON.stringify(reviewed.result));
        await h.kit.authorizations.share(h.admin, review.answer.run!.run, [h.alice.id]);
        const reviewRun = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: review.answer.run!.run })).items[0], reviewResult = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: review.answer.run!.run, newestFirst: true })).items[0], oldRun = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: original.run })).items[0], oldResult = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: original.run, newestFirst: true })).items[0];
        const second = await h.service.startRunDetailed(h.alice, { ...start, pack: 'recompose', predecessor: original.run, inputs: { ...inputs, review_run: { reference: 'rec:' + reviewRun.digest }, review_result: { reference: 'rec:' + reviewResult.digest }, previous_run: { reference: 'rec:' + oldRun.digest }, previous_result: { reference: 'rec:' + oldResult.digest } }, parameters: { case_depths: [1] } }, call());
        assert.equal(second.answer.call_result, 'ok', JSON.stringify(second.answer.errors));
        record.predecessor = original.run;
        for (const state of record.sources.states)
            state.adjudicated_by = 'rec:' + reviewResult.digest;
        const done = await h.service.submitResult(h.alice, submit(second.answer.run!.run, second.answer.run!.items[0].id, record), call());
        assert.equal(done.acceptance, 'accepted', JSON.stringify(done.errors));
        assert.ok(Object.values(done.result!.partitions).flat().every(i => i.requirements.every(r => r.status === 'satisfied')), JSON.stringify(done.result));
        assert.ok(done.result!.cross_item.some(c => c.requirement === 'full_set' && c.statement.verdict === 'support'));
        const saved = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: second.answer.run!.run })).items[0], result = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: second.answer.run!.run, newestFirst: true })).items[0];
        const bound = (kind: string, entry: any) => ({ external: null, meta: { kind, record: entry.digest }, model: { kind, body: entry.body } }), proof = admittedRecomposition(bound('run', saved), bound('validation_result', result), { product: 'orbit', root: build.root, product_pack_digest: product.version.digest }, record.case.source_ref, record.case.node);
        assert.ok(proof);
        assert.equal(proof.record.status, 'complete');
        assert.equal((await h.service.getRun(h.alice, original.run))!.run.predecessor, undefined);
        assert.equal((saved.body as any).predecessor, original.run);
        // Consume the exact admitted case, then perform B1 criterion review, client export and successor workbook verification.
        const runtime = blockFixture(), rawContract = structuredClone(runtime.contractDoc) as any;
        rawContract.effects.command.command_scope = ['/commands/widget', '/commands/no/widget', '/commands/show'];
        const contract = signTypedRuntime(rawContract), profile = structuredClone(runtime.profileDoc);
        profile.runtime.contract_sha256 = contract.original.contract_sha256;
        profile.workbook.autoid_pattern = '^orbit-case-[0-9]+$';
        const extra = (words: string[], params: any[]) => ({ words, reference: 'tree:' + build.root + '/commands/' + words.join('/'), signatures: [{ id: words.join('/'), reference: 'src:' + build.root + '/xml@1/x/' + words.join('/') + '/arguments', params }] });
        const pool = { name: 'pool', type: 'string' as const, native_type: { name: 'synthetic-string', declaration: 'src:' + build.root + '/xml@1/x/arg', grammar: 'synthetic-tree@1' } };
        const catalog = [...f.catalog.entries, extra(['show', 'health'], [pool]), extra(['no', 'widget', 'health', 'interval'], [pool])];
        h.knowledge.catalog = async () => createCatalogView(catalog, { reference: 'tree:' + build.root + '/commands', complete: true, caseSensitive: true });
        for (const [name, value] of Object.entries({ contract, profile, inventory: runtime.inventory }))
            put('doc:doc:b2-' + name, JSON.stringify(value));
        const compileInputs = { subject: { external }, contract: { external: 'doc:doc:b2-contract' }, profile: { external: 'doc:doc:b2-profile' }, inventory: { external: 'doc:doc:b2-inventory' }, recomposition_run: { reference: 'rec:' + saved.digest }, recomposition_result: { reference: 'rec:' + result.digest } };
        const compileParameters = { autoid: record.case.id, pipeline: 'recomposed' };
        const planStarted = await h.service.startRunDetailed(h.alice, { ...start, pack: 'case-compile', inputs: compileInputs, parameters: compileParameters }, call());
        assert.equal(planStarted.answer.call_result, 'ok', JSON.stringify(planStarted.answer.errors));
        const expected = record.contract.expectation, quote = { reference: expected.quote_ref, text: expected.text }, criterion = { id: 'interval_literal', expectation: quote.reference, quote, kind: 'literal', operator: 'abs_found', literal: 'interval=5', rationale: '合成模型选择可观察间隔字段，交独立复核', scope_root: build.root };
        const data = blockPlan([{ kind: 'CONFIG', id: 'configure', call: blockCall('widget health interval pool1 5') }, { kind: 'OBSERVE_ASSERT', id: 'observe', call: blockCall('show health pool1'), assertions: [{ id: 'assert_interval', output: 'observe', op: 'abs_found', literal: 'interval=5', quote, expectation: quote.reference, criterion: criterion.id }] }, { kind: 'CONFIG', id: 'cleanup', cleanup: true, call: blockCall('no widget health interval pool1') }], [{ expectation: quote.reference, status: 'asserted', assertions: ['assert_interval'] }]);
        data.criteria = [criterion];
        data.block_context = { preconditions: [], causal_links: [{ from: 'configure', to: 'observe', quote }], responders: [] };
        data.recomposition = { receipt: 'rec:' + result.digest, case_id: record.case.id, slots: [{ slot: 'e1', assertions: ['assert_interval'] }], rebindings: [] };
        const planSubmission = (run: any) => ({ run: run.run, model: 'scripted-compiler', items: [{ item: run.items[0].id, handling: 'handled' as const, slots: { plan: [{ text: '合成编写消费已受理重组', quotes: [quote], data }] } }] });
        const planDraft = await h.service.submitResult(h.alice, planSubmission(planStarted.answer.run!), call());
        assert.equal(planDraft.acceptance, 'accepted', JSON.stringify(planDraft.errors));
        for (const requirement of Object.values(planDraft.result!.partitions).flat().flatMap(i => i.requirements).filter(r => ['contract_methods', 'commands_known', 'bed_addresses'].includes(r.requirement)))
            assert.equal(requirement.status, 'satisfied', JSON.stringify(requirement));
        const publishedReview = await h.registry.publish(h.alice, await stageRecompose('review', join(temp.path, 'criterion-review')));
        assert.equal(publishedReview.ok, true, JSON.stringify(publishedReview));
        await h.registry.assign(h.admin, h.admin.id, 'case-compile-criterion-review');
        const planRecord = (await h.kit.store.find({ kind: 'submission', key: INDEX.submissionRun, value: planStarted.answer.run!.run })).items[0];
        const criterionRun = await h.service.startRunDetailed(h.admin, { pack: 'case-compile-criterion-review', predecessor: planStarted.answer.run!.run, inputs: { declaration: { reference: 'rec:' + planRecord.digest }, evidence: [{ reference: record.case.source_ref }] } }, call());
        assert.equal(criterionRun.answer.call_result, 'ok', JSON.stringify(criterionRun.answer.errors));
        const criterionResult = await h.service.submitResult(h.admin, { run: criterionRun.answer.run!.run, model: 'scripted-criterion-reviewer', items: criterionRun.answer.run!.items.map(i => ({ item: i.id, handling: 'handled', slots: { review: [{ code: 'accept', text: '合成判据独立复核', location: i.location, quotes: [quote], data: { reason: '合成输出字段忠实覆盖原期望' } }] } })) }, call());
        assert.equal(criterionResult.acceptance, 'accepted', JSON.stringify(criterionResult.errors));
        await h.kit.authorizations.share(h.admin, criterionRun.answer.run!.run, [h.alice.id]);
        const criterionSnapshot = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: criterionRun.answer.run!.run })).items[0], criterionReceipt = (await h.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: criterionRun.answer.run!.run, newestFirst: true })).items[0];
        const finalInputs = { ...compileInputs, criteria_review_run: { reference: 'rec:' + criterionSnapshot.digest }, criteria_review: { reference: 'rec:' + criterionReceipt.digest } };
        const ready = await h.service.startRunDetailed(h.alice, { ...start, pack: 'case-compile', predecessor: planStarted.answer.run!.run, inputs: finalInputs, parameters: compileParameters }, call());
        assert.equal(ready.answer.call_result, 'ok', JSON.stringify(ready.answer.errors));
        const sent = planSubmission(ready.answer.run!), readyResult = await h.service.submitResult(h.alice, sent, call());
        assert.equal(readyResult.acceptance, 'accepted', JSON.stringify(readyResult.errors));
        for (const requirement of Object.values(readyResult.result!.partitions).flat().flatMap(i => i.requirements).filter(r => r.requirement !== 'workbook_verified'))
            assert.equal(requirement.status, 'satisfied', JSON.stringify(requirement));
        const recipe = satisfiedRecipe({ run: ready.answer, result: readyResult, submission: sent, contract: Buffer.from(JSON.stringify(contract)), profile: Buffer.from(JSON.stringify(profile)), inventory: Buffer.from(JSON.stringify(runtime.inventory)) }), workbook = generateWorkbook(recipe);
        await h.kit.artifacts.ingest({ bytes: workbook, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', origin: { upload: { session: 'synthetic-client', message: null } }, author: { user: h.alice.id }, provenanceType: 'declared', visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: false }, name: 'synthetic-recomposed.xlsx' });
        const verifiedStart = await h.service.startRunDetailed(h.alice, { ...start, pack: 'case-compile', predecessor: ready.answer.run!.run, inputs: { ...finalInputs, workbook: { reference: 'src:' + sha(workbook) } }, parameters: { ...compileParameters, plan_run: ready.answer.run!.run } }, call());
        assert.equal(verifiedStart.answer.call_result, 'ok', JSON.stringify(verifiedStart.answer.errors));
        const verified = await h.service.submitResult(h.alice, planSubmission(verifiedStart.answer.run!), call());
        assert.equal(verified.acceptance, 'accepted', JSON.stringify(verified.errors));
        assert.ok(Object.values(verified.result!.partitions).flat().every(i => i.requirements.every(r => r.status === 'satisfied')), JSON.stringify(verified.result));
        // Incremental candidates always retain the full task set; empty yet-unjudged slots do not spend repair rounds.
        const multi = { root: { data: { id: 'part-root', text: 'ORBIT / COMET synthetic parts' }, children: [JSON.parse(fixtureText('author-pass.km.json')).root.children[0], JSON.parse(fixtureText('author-underdetermined.km.json')).root.children[0]] } }, multiBytes = JSON.stringify(multi), multiRef = 'src:' + sha(multiBytes), multiExternal = 'agile:mindmap:synthetic-parts';
        put(multiExternal, multiBytes);
        const partsStart = await h.service.startRunDetailed(h.alice, { ...start, pack: 'recompose', inputs: { ...inputs, subject: { external: multiExternal } }, parameters: { case_depths: [1] } }, call());
        assert.equal(partsStart.answer.call_result, 'ok', JSON.stringify(partsStart.answer.errors));
        const partsRun = partsStart.answer.run!;
        const parts: any[] = [];
        for (const [index, name] of ['pass', 'underdetermined'].entries()) {
            const r = fixtureJson('recompose-' + name + '.json'), old = r.case.source_ref;
            const replace = (value: any): any => typeof value === 'string' && (value === old || value.startsWith(old + '/')) ? multiRef + value.slice(old.length) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : value;
            const next = replace(r);
            const q = [...quotes.filter((v: any) => !v.reference.startsWith(record.case.source_ref)), ...next.atoms.map((a: any) => ({ reference: a.quote_ref, text: a.text }))];
            parts.push({ run: partsRun.run, model: 'scripted-recomposer', items: [{ item: partsRun.items[index].id, handling: 'handled', slots: { record: [{ text: '合成逐案候选', quotes: q, data: next }] } }] });
            const aggregate = assembleRecompose({ run: partsRun }, parts, 'scripted-recomposer');
            assert.equal(aggregate.draft.items.length, 2);
            const partial = await h.service.submitResult(h.alice, aggregate.draft, call());
            assert.equal(partial.acceptance, 'accepted', JSON.stringify(partial.errors));
            assert.equal(partial.result!.rounds.used, 0, JSON.stringify(partial.errors));
            if (index === 0)
                assert.ok(partial.result!.cross_item.some(c => c.requirement === 'full_set' && c.statement.verdict === 'unknown'));
            else
                assert.ok(partial.result!.cross_item.some(c => c.requirement === 'full_set' && c.statement.verdict === 'support'));
        }
        const storedParts = await h.kit.store.find({ kind: 'submission', key: INDEX.submissionRun, value: partsRun.run });
        assert.equal(storedParts.items.length, 2);
    }
    finally {
        await h?.close();
        await temp.remove();
        await postgres.stop();
    }
});
