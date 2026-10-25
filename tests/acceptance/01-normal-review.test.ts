// Scenario 1 (brief section 9): a normal review. A reviewer lists the task packs, starts the draft review on the agile
// platform's ~150-node synthetic mind map by its external id, and hands in every item; every item is delivered, each
// (item, requirement) has its terminal on the one layer the requirement declares, the satisfaction counts follow from
// the terminals, and the dynamic layer is "not applicable" (no entry, `本层不适用` in the text). The expected answers come
// from the fixture document itself (oracle over the tagged rule) and from its documented defects.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { actionsOf } from '../../hub/runs/engine/store.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { PARTITION } from '../../contracts/generated/vocabulary.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { WORKFLOW } from './support/env.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, itemsOf, oracleCases, refutationCodes, requirementOf, resultOf, sharedIds, startReview, staticLayer, type OracleCase } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;
const document = JSON.parse(fixtureText('review-150.km.json')) as { root: never };
const cases: OracleCase[] = oracleCases(document);

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s01-draft');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 1: a normal review', () => {
  let run: RunSummary;
  let result: ValidationResult;
  let receiptText = '';

  test('list_task_packs shows exactly the workflow packs assigned to the reviewer, never a product or system pack', async () => {
    const listed = await client.call('list_task_packs', {});
    assert.equal(listed.isError, false);
    assert.deepEqual(listed.out.packs.map((p) => p.id).sort(), Object.values(WORKFLOW).sort());
    assert.ok(listed.out.packs.every((p) => p.kind === 'workflow'));
    const review = listed.out.packs.find((p) => p.id === WORKFLOW.review)!;
    assert.deepEqual(review.requirements.map((r) => r.key), ['literal', 'catalog', 'findings', 'expected_quality', 'level']);
    assert.deepEqual(new Set(review.products), new Set([...bed.product.names, ...bed.second.names]), 'the pack binds no fixed line: every name of every line that provides its catalog');
  });

  test('start_run on the agile mind map freezes the items, requirements, locked root and the expected sources', async () => {
    run = await startReview(client, { product: bed.product.names[1], version: bed.site.LINE, parameters: { stories: ['31057'], bugs: ['31057'] }, inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } } });
    // Items: exactly the cases of the tagged rule, in document order, with their identities.
    const expectedIds = cases.map((c) => c.nodeId);
    const shared = sharedIds(cases);
    assert.equal(run.items.length, cases.length);
    run.items.forEach((item, i) => {
      const nodeId = expectedIds[i];
      if (shared.has(nodeId)) assert.match(item.id, new RegExp(`^${DOCUMENTS.review}:${nodeId}#[12]$`), 'a shared id gets a pack identity per copy');
      else assert.equal(item.id, `${DOCUMENTS.review}:${nodeId}`);
      assert.equal(item.label, cases[i].text.replace(/\s+/g, ' ').trim());
      assert.match(item.location, /^src:[0-9a-f]{64}\/kityminder@1\//);
      assert.ok((item.summary ?? '').length <= 200, 'a model reads id, label and summary: the summary stays short');
      assert.match(item.digest ?? '', /^[0-9a-f]{64}$/);
    });
    // Requirements: static layer only; the dynamic layer is not declared, so it is not applicable.
    assert.deepEqual(run.requirements.map((r) => [r.key, r.layers, r.accepted_producer]), [
      ['literal', ['static'], 'fact'],
      ['catalog', ['static'], 'fact'],
      ['findings', ['static'], 'judgment'],
      ['expected_quality', ['static'], 'judgment'],
      ['level', ['static'], 'judgment'],
    ]);
    // The second name of the line locks the root the sync produced for the base build (aliasing).
    assert.equal(run.product, bed.product.line);
    assert.equal(run.version, bed.site.LINE);
    const produced = bed.syncs.two!.builds.find((b) => b.outcome === 'produced');
    assert.ok(produced && produced.root);
    assert.equal(run.root, produced.root);
    assert.deepEqual(run.target_basis.map(claim=>claim.statement.data?.field),['product','version','build','unversioned_root']);
    const scopeBasis=run.target_basis[3];
    assert.equal(scopeBasis.qualifier.nature,'fact');assert.equal(scopeBasis.qualifier.provenance,'projected');
    // Feeding replaced implicit per-build case indexing. No unversioned source declaration
    // is configured in this bed; absence is disclosed rather than inventing an empty closed root.
    assert.equal(bed.syncs.two!.scope,undefined);
    assert.equal(run.unversioned_root,undefined);
    assert.equal(scopeBasis.statement.data?.root,null);
    assert.equal(scopeBasis.statement.data?.composition,null);
    assert.equal(scopeBasis.statement.text,'这条产品线还没有不分版本的根；下一步：同步这条产品线');
    // Sources: the subject and explicitly declared story/bug; prose creates no search identities.
    const roles = run.sources.map((s) => [(s.external ?? '').split('@')[0].split(':').slice(0, 2).join(':'), s.role]);
    assert.deepEqual(roles.filter(([k]) => k === 'agile:mindmap'), [['agile:mindmap', 'subject']]);
    assert.deepEqual(roles.filter(([k]) => k.startsWith('plm:')).sort(), [['plm:bug', 'expected'], ['plm:story', 'expected']]);
    // R6: prose feature words do not create source identities or searches.
    assert.deepEqual(roles.filter(([k]) => k === 'manual:spec-search'), []);
    assert.deepEqual(roles.filter(([k]) => k === 'manual:qa-search' || k === 'agile:search').map(([, r]) => r), []);
    assert.ok(run.instructions.length > 0 && /^[0-9a-f]{64}$/.test(run.instructions_digest));
    // The default rule is 标签或标记 (marked): the frozen document group (in the stored run record; the start_run
    // answer itself carries no groups) says so, with how many cases the marker alone found — the independent oracle
    // counts the same untagged marked cases in this fixture.
    const frozenGroups = (await bed.hub.records.store.find({ key: 'runs.id', value: run.run })).items[0]?.body as { groups?: Array<Record<string, unknown>> } | undefined;
    const documentGroup = (frozenGroups?.groups ?? []).find((g) => g.kind === 'document') as { rule_summary?: string; marked_only?: number } | undefined;
    assert.ok(documentGroup, 'the run freezes the document group with the rule summary');
    const markedOnly = cases.filter((c) => c.markedOnly).length;
    assert.equal(documentGroup.marked_only, markedOnly, 'marked_only is the oracle\'s count of marker-only cases');
    assert.match(documentGroup.rule_summary ?? '', new RegExp(`^用例规则：标签或标记；其中 ${markedOnly} 个只靠标记识别（没有标签）$`));
    assert.equal(run.session, 'sess-s01-draft', 'the session id observed from the Circle-Session-Id header');
  });

  test('every item is handed in: the receipt is accepted, every item delivered, and each requirement has one static terminal', async () => {
    const answer = await client.call('submit_result', draft(run));
    assert.equal(answer.isError, false, answer.text.slice(0, 1500));
    assert.equal(answer.out.acceptance, 'accepted');
    result = resultOf(answer);
    receiptText = answer.text;
    assert.equal(result.partitions.delivered.length, run.items.length);
    for (const p of PARTITION) if (p !== 'delivered') assert.equal(result.partitions[p].length, 0, `${p} is empty`);
    const seenPartitionItems = new Set<string>();
    for (const p of PARTITION) {
      for (const it of result.partitions[p]) {
        assert.ok(!seenPartitionItems.has(it.item), `item ${it.item} must not appear in multiple partitions`);
        seenPartitionItems.add(it.item);
      }
    }
    assert.deepEqual(Array.from(seenPartitionItems).sort(), run.items.map((it) => it.id).sort(), 'partition union strictly equals run items');
    assert.deepEqual(result.coverage, { complete: true, examined: run.items.length, total: run.items.length, note: result.coverage.note });
    // Counts are derived from the partitions, never stored (W08 R[0]).
    const counts = answer.out.counts!;
    assert.equal(counts.delivered, run.items.length);
    for (const { item } of itemsOf(result)) {
      assert.deepEqual(item.requirements.map((r) => r.requirement), ['literal', 'catalog', 'findings', 'expected_quality']);
      const quality=item.requirements.find(requirement=>requirement.requirement==='expected_quality')!;
      assert.equal(quality.status,'pending','an omitted optional semantic judgment stays unjudged');
      assert.ok(quality.claims.every(claim=>claim.warrant.producer!=='model'),'an empty slot invents no model judgment');
      for (const r of item.requirements) {
        assert.deepEqual(r.layers.map((l) => l.layer), ['static'], 'no dynamic entry: not applicable');
        // V03 F[2]: the status follows from the terminal (no expected-outcome override applies to a normal case).
        const terminal = r.layers[0].terminal;
        if (terminal === 'pass' || terminal === 'judgment') assert.equal(r.status, 'satisfied');
        if (terminal === 'unchecked') assert.equal(r.status, 'pending');
        if (terminal === 'violation' && r.requirement === 'literal') assert.deepEqual([r.status, r.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
      }
    }
    // The level is a cross-item claim of the run-level requirement, listed apart.
    assert.deepEqual(result.cross_item.map((c) => [c.requirement, c.statement.code, c.statement.rank, c.qualifier.nature]), [['level', 'level', 'P4', 'judgment']]);
  });

  test('the Hub\'s literal facts are the fixture\'s documented defects', () => {
    const idOf = (c: OracleCase) => run.items[cases.indexOf(c)].id;
    const noExpected = cases.filter((c) => c.expected.length === 0 && c.stepExpected.length === 0);
    const noPriority = cases.filter((c) => c.priority === null);
    const badPriority = cases.filter((c) => typeof c.priority === 'number' && (c.priority < 1 || c.priority > 3));
    assert.equal(noExpected.length, 1);
    assert.equal(noPriority.length, 1);
    assert.equal(badPriority.length, 1);
    assert.ok(refutationCodes(result, idOf(noExpected[0]), 'literal').includes('core.structure.required_empty'), 'a case without an expected result');
    assert.ok(refutationCodes(result, idOf(noPriority[0]), 'literal').includes('core.structure.required_empty'), 'a case without a priority');
    assert.ok(refutationCodes(result, idOf(badPriority[0]), 'literal').includes('core.structure.type_mismatch'), 'a priority outside 1-3');
    // Two siblings with the same title and the same expected results: both are duplicates.
    const key = (c: OracleCase) => JSON.stringify([c.path, c.text, c.expected, c.stepExpected]);
    const twins = cases.filter((c) => cases.filter((d) => key(d) === key(c)).length > 1);
    assert.equal(twins.length, 2);
    for (const twin of twins) assert.ok(refutationCodes(result, idOf(twin), 'literal').includes('core.structure.duplicate_key'));
    // Two cases sharing one node id: the advisory numbering check reports both.
    const shared = cases.filter((c) => sharedIds(cases).has(c.nodeId));
    assert.equal(shared.length, 2);
    for (const c of shared) assert.ok(refutationCodes(result, idOf(c), 'literal').includes('core.structure.duplicate_key'));
    // A case without any literal defect and with the document's usual tag spelling passes.
    const clean = cases.find((c) => c.tags.length === 1 && c.tags[0] === 'configuration' && c.expected.length === 1 && c.priority === 2 && !twins.includes(c))!;
    assert.deepEqual(staticLayer(result, idOf(clean), 'literal'), { layer: 'static', terminal: 'pass' });
    const undeclaredNegative=cases.find(c=>c.tags.includes('Negative'))!;
    assert.equal(run.items[cases.indexOf(undeclaredNegative)].fields.negative,null);
    assert.ok(refutationCodes(result,idOf(undeclaredNegative),'literal').includes('case-review.tag_variant'));
    // No finding cites a command here. The review now reads the negative case's own literal lines instead.
    // The active site fixture declares interval/retries/probe, endpoint add and show health only.
    // Weight and pool add/delete are absent from that catalog; they cannot provide a verifiable command here.
    const negativeCodes = new Map([
      ['widget health interval pool1 61', 'core.catalog.param_out_of_range'],
      ['widget health retries pool1 0', 'core.catalog.param_out_of_range'],
      ['relay endpoint weight 192.0.2.21 101', 'case-review.negative_command_missing'],
      ['relay endpoint weight 192.0.2.22 abc', 'case-review.negative_command_missing'],
      ['WebUI 输入间隔 0 时提示错误', 'case-review.negative_command_missing'],
      ['后端端口不可达时探测超时', 'case-review.negative_command_missing'],
      ['探测类型输入 udp 被拒绝', 'case-review.negative_command_missing'],
      ['删除不存在的池', 'case-review.negative_command_missing'],
      ['池名称超过 32 个字符', 'case-review.negative_command_missing'],
    ]);
    const negatives = run.items.filter((i) => i.fields.negative === true);
    assert.equal(negatives.length, cases.filter((c) => c.tags.includes('negative')).length);
    for (const n of negatives) {
      const code = negativeCodes.get(n.label);
      assert.ok(code, `negative fixture expectation missing for ${n.label}`);
      assert.equal(staticLayer(result, n.id, 'catalog').terminal, 'violation');
      const codes = refutationCodes(result, n.id, 'catalog');
      assert.ok(codes.includes(code), `${n.label}: expected ${code}, got ${codes.join(', ')}`);
    }
    // Judgments are terminal `judgment`, satisfied by the accepted producer.
    for (const item of run.items) assert.equal(staticLayer(result, item.id, 'findings').terminal, 'judgment');
  });

  test('the receipt text states the counts per requirement as the structured result has them, the dynamic layer not applicable', () => {
    for (const key of ['literal', 'catalog', 'findings']) {
      const statuses = run.items.map((i) => requirementOf(result, i.id, key).status);
      const count = (s: string) => statuses.filter((x) => x === s).length;
      const line = receiptText.split('\n').find((l) => l.startsWith(`- ${key}：`));
      assert.ok(line, `the text has a line for ${key}`);
      assert.ok(line.includes(`满足 ${count('satisfied')}，未满足 ${count('unsatisfied')}`), line);
      assert.ok(line.includes(`未决 ${count('pending')}`), line);
      assert.ok(line.endsWith('动态：本层不适用'), line);
    }
    const unknown = itemsOf(result).filter(({ item }) => item.requirements.some((r) => r.layers.some((l) => l.terminal === 'unchecked'))).length;
    assert.ok(receiptText.startsWith(`回执：已受理；分区：已交付 ${run.items.length}，已拒收 0，已隔离 0，未完成 0；未知 ${unknown}`), receiptText.slice(0, 200));
  });

  test('real effects: stored records, call log lines, and console HTML page', async () => {
    // 1. Stored records: run record, submission record, validation result record
    const runRecords = await bed.hub.records.store.find({ key: 'runs.id', value: run.run });
    assert.equal(runRecords.items.length, 1, 'run record is stored');
    const storedRun = runRecords.items[0];
    assert.equal(storedRun.schema, 'run@1');
    assert.equal((storedRun.body as { run: string }).run, run.run);

    const resultRecords = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(resultRecords.items.length, 1, 'validation result is stored in records package');
    assert.equal(resultRecords.items[0].schema, 'validation@1');
    assert.deepEqual(resultRecords.items[0].body, result);

    const submissionRecords = await bed.hub.records.store.find({ key: 'runs.submission.run', value: run.run });
    assert.equal(submissionRecords.items.length, 1, 'submission record is stored');
    assert.equal(submissionRecords.items[0].schema, 'submission@1');

    // 2. Call log: entries for start_run and submit_result with session and trace
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    assert.ok(logs.items.length >= 2, 'call log contains entries for the run');
    const submitLog = logs.items.find((entry) => entry.tool === 'submit_result');
    assert.ok(submitLog, 'submit_result is recorded in call log');
    assert.equal(submitLog.acceptance, 'accepted');
    assert.equal(submitLog.session, 'sess-s01-draft');
    assert.match(submitLog.trace_id, /^[0-9a-f]{32}$/);
    assert.match(submitLog.args_digest, /^[0-9a-f]{64}$/);
    assert.ok(typeof submitLog.args_size === 'number' && submitLog.args_size > 0);

    // 3. Console HTML: authoritative view of the run
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(run.run), 'console page mentions the run id');
    assert.ok(page.body.includes('已交付'), 'console page contains delivered partition group');
    assert.ok(page.body.includes(String(run.items.length)), 'console page shows delivered count');
  });
});


describe('scenario 1b: the same mind map under case_rule "tagged"', () => {
  test('the restriction returns to tagged-only items with the rule named in the receipt and a warning for the lookalikes', async () => {
    const taggedCases = oracleCases(document, { rule: 'tagged' });
    const lookalikes = cases.filter((c) => c.markedOnly).length;
    const run = await startReview(client, {
      product: bed.product.names[1],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      parameters: { case_rule: 'tagged' },
    });
    assert.equal(run.items.length, taggedCases.length, 'the restriction projects exactly the tagged cases');
    // Shared node ids get a pack identity per copy (#1/#2), the same suffixing as the default rule's items.
    const sharedTagged = sharedIds(taggedCases);
    run.items.forEach((item, i) => {
      const nodeId = taggedCases[i].nodeId;
      if (sharedTagged.has(nodeId)) assert.match(item.id, new RegExp(`^${DOCUMENTS.review}:${nodeId}#[12]$`));
      else assert.equal(item.id, `${DOCUMENTS.review}:${nodeId}`);
    });
    const frozen = (await bed.hub.records.store.find({ key: 'runs.id', value: run.run })).items[0]?.body as { groups?: Array<Record<string, unknown>>; gaps?: unknown[] } | undefined;
    const documentGroup = (frozen?.groups ?? []).find((g) => g.kind === 'document') as { rule_summary?: string; marked_only?: number } | undefined;
    assert.ok(documentGroup, 'the run freezes the document group');
    assert.equal(documentGroup.marked_only, 0, 'marked_only is 0 under the restriction');
    assert.match(documentGroup.rule_summary ?? '', /^用例规则：只认标签；其中 0 个只靠标记识别（没有标签）$/);
    // The lookalike warning: the count of nodes that look like a case but have no tags, with their locations. A run
    // with items keeps the projection's warnings in the detail of its parse action (the start_run answer carries gaps
    // only when the projection returned no items), so the warning is read from the parse action.
    const parse = (await actionsOf(bed.hub.records.store, run.run)).find((a: { body: { action: string } }) => a.body.action === 'parse');
    assert.ok(parse, 'the run has its parse action');
    const warnings = ((parse.body.detail.warnings as unknown[]) ?? []).map((w) => JSON.stringify(w)).join('\n');
    const lookalike = /case-review\.untagged_cases/.exec(warnings);
    assert.ok(lookalike, `the parse action carries the untagged lookalike warning: ${warnings.slice(0, 300)}`);
    assert.match(warnings.slice(lookalike.index), new RegExp(`[^0-9]${lookalikes}[^0-9]`), 'the warning counts the lookalikes');
    assert.match(warnings.slice(lookalike.index, lookalike.index + 400), /case_rule=tagged/);
  });
});
