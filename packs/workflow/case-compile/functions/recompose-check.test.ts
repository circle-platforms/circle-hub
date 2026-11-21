import assert from 'node:assert/strict';
import { test } from 'node:test';
import projectRecompose from '../recompose/functions/project.ts';
import { fixture } from '../testing/recompose.ts';
import { checkRecomposition } from './recompose-check.ts';
const outcomes = (f: ReturnType<typeof fixture>) => checkRecomposition({ subject: f.subject });
test('the migrated synthetic complete path has exact original atoms and verified receipts', () => {
  const f = fixture();
  const out = outcomes(f);
  assert.deepEqual(out.map(o => o.verdict), ['support'], JSON.stringify(out));
  assert.match(out[0].statement, /原文、改写、具体取值、重新绑定四类记录已核对；来源状态与缺口是模型判断，交给脚本编写/);
  assert.doesNotMatch(out[0].statement, /四账|四本账/);
});
test('recompose projection exposes fields.title from the case intent atom when present', () => {
  const model = {
    nodes: [
      { text: 'ORBIT synthetic root', selector: 'n/0', data: { id: 'root' }, children: [1, 2] },
      { text: '合成用例意图：验证健康检查间隔', selector: 'n/0/0', data: { id: 'c1', autoid: 'orbit-case-0001' }, children: [3] },
      { text: 'widget health interval pool1 5', selector: 'n/0/1', data: { id: 'c2', autoid: 'orbit-case-0002', compile_layout: 'case_body_expectations' }, children: [5] },
      { text: 'widget health interval pool1 5', selector: 'n/0/0/0', data: { id: 's1' }, children: [4] },
      { text: 'show health 显示 pool1 的探测间隔为 5 秒', selector: 'n/0/0/0/0', data: { id: 'e1' }, children: [] },
      { text: 'show health 显示 pool1 的探测间隔为 5 秒', selector: 'n/0/1/0', data: { id: 'e2' }, children: [] },
    ],
  };
  const sha256 = 'a'.repeat(64);
  const projected = projectRecompose({ inputs: [{ slot: 'subject', parser: 'kityminder@1', model, sha256 }], parameters: { case_depths: [1] } });
  assert.equal(projected.items?.length, 2);
  const withIntent = projected.items![0].fields;
  assert.equal(withIntent.atoms.find((a: { kind: string }) => a.kind === 'intent')?.text, '合成用例意图：验证健康检查间隔');
  assert.equal(withIntent.title, '合成用例意图：验证健康检查间隔');
  const withoutIntent = projected.items![1].fields;
  assert.equal(withoutIntent.atoms.find((a: { kind: string }) => a.kind === 'intent'), undefined);
  assert.equal(withoutIntent.title, undefined);
});
for (const name of ['underdetermined', 'missing-prerequisite'] as const)
    test(name + ' goes on to the writer with its reason (decision 155)', () => { const f = fixture(name); f.record.status = 'complete'; f.record.unknowns = f.record.unknowns ?? []; const result = outcomes(f); assert.ok(!result.some(o => /^用例原句 .* 状态 /.test(o.statement)), JSON.stringify(result)); assert.ok(f.record.sources.states.some((s: any) => s.state !== 'settled')); });
test('conflict between two signed sources refuses completion without choosing a side', () => { const f = fixture('conflict'); assert.ok(outcomes(f).some(o => o.verdict === 'refute' && o.data?.status === 'refused')); });
for (const [name, mutate, code] of [
    ['quote', (f: any) => f.record.contract.expectation.text = '非原文', 'quote_not_verbatim'],
    ['missing', (f: any) => { f.record.contract.method.kind = 'missing'; f.record.unknowns = []; }, 'missing_without_exit'],
    ['candidate', (f: any) => f.record.sources.candidates = [{ ref: 'src:' + '0'.repeat(64), found_by: 'search', signing_authority: true }], 'candidate_signed'],
    ['prerequisite', (f: any) => { f.record.sources.states[0].state = 'conflict'; f.record.sources.states[0].prerequisites = [f.record.atoms[0].quote_ref]; }, 'prerequisite_as_conflict'],
    ['load', (f: any) => { f.record.ledgers.adapted[0].load_bearing = false; f.record.ledgers.adapted[0].changes = [{ role: 'asserted_value', from_ref: f.record.atoms[0].quote_ref, to_ref: f.record.atoms[0].quote_ref }]; }, 'unmarked_load_bearing'],
    ['bed', (f: any) => f.record.ledgers.adapted[0].device_index = 0, 'bound_to_bed'],
    ['drop', (f: any) => f.record.ledgers.adapted[0].commands = [], 'atom_dropped']
] as const)
    test('dedicated refusal ' + name, () => { const f = fixture(); mutate(f); assert.ok(outcomes(f).some(o => o.code === 'recompose.' + code), JSON.stringify(outcomes(f))); });
test('two distinct synthetic beds cannot affect bytes or conclusions', async () => { const f = fixture(), before = JSON.stringify(f.record), a = checkRecomposition({ subject: { ...f.subject, bed: { name: 'bed-a' } } }), b = checkRecomposition({ subject: { ...f.subject, bed: { name: 'bed-b' } } }); assert.deepEqual(a, b); assert.equal(JSON.stringify(f.record), before); });
test('a copied adjudication upload never replaces a genuine accepted Hub review', () => { const f = fixture(); f.subject.review_result = { ...f.review.result, external: 'doc:doc:imitation', meta: null } as any; assert.ok(outcomes(f).some(o => o.verdict === 'unknown')); });
test('missing authority and source_of_value stay unknown rather than inventing value authority', () => { const f = fixture(); delete f.record.ledgers.adapted[0].authority; delete f.record.ledgers.adapted[0].source_of_value; assert.ok(outcomes(f).some(o => o.verdict === 'unknown' && o.missing.includes('source_of_value'))); });
test('coverage uses the source-derived atom set, not self-reported totals', () => { const f = fixture(); f.record.atoms.pop(); f.record.coverage.author_atoms = ['a1']; delete f.record.coverage.mapped.a2; assert.ok(outcomes(f).some(o => o.code === 'recompose.atom_dropped')); });
test('foreign original-ledger rows and source states cannot masquerade as covered authorship', () => { const a = fixture(); a.record.ledgers.original.push({ atom: 'foreign', text: '其他原文', quote_ref: a.record.atoms[0].quote_ref }); assert.ok(outcomes(a).some(o => o.code === 'recompose.quote_not_verbatim')); const b = fixture(); b.record.sources.states.push({ ...b.record.sources.states[0], atom: 'foreign' }); assert.ok(outcomes(b).some(o => o.code === 'recompose.atom_dropped')); });
test('declared native parameter changes require a value ledger and load-bearing conditions', () => { const f = fixture(); f.record.ledgers.adapted[0].commands = ['widget health interval pool1 6']; f.record.ledgers.adapted[0].load_bearing = false; const result = outcomes(f); assert.ok(result.some(o => o.code === 'recompose.unmarked_load_bearing')); assert.ok(result.some(o => o.verdict === 'unknown' && o.missing.includes('具体化'))); });
test('a reference to a parsed physical inventory is a bed binding, without scanning prose labels', () => { const f = fixture(), ref = 'src:' + 'f'.repeat(64); f.record.ledgers.adapted[0].source_of_value = ref; (f.subject as any).bed_sources = [ref]; assert.ok(outcomes(f).some(o => o.code === 'recompose.bound_to_bed')); });
test('a concrete value needs actual scalar evidence and the product closed set', () => { const f = fixture(), declaration = f.authority.values[0], ref = declaration.ref + '/values/0'; f.record.ledgers.concretizations = [{ atom: 'a1', slot: declaration.slot, value: 5, value_ref: ref, source_of_value: declaration.ref, source_kind: 'catalog', decided_by: 'scripted-model', authority: declaration.ref }]; f.subject.evidence.push({ reference: ref, resolved: true, text: '5' }); const row = outcomes(f); assert.ok(!row.some(o => o.missing?.includes('具体化')), JSON.stringify(row)); const invalid = fixture(); invalid.record.ledgers.concretizations = [{ slot: declaration.slot, value: 99, value_ref: ref, source_of_value: declaration.ref, source_kind: 'catalog', decided_by: 'scripted-model', authority: declaration.ref }]; invalid.subject.evidence.push({ reference: ref, resolved: true, text: '99' }); assert.ok(outcomes(invalid).some(o => o.verdict === 'unknown' && o.missing.includes('闭集'))); });
test('an accepted judgment from another root is not rebound to current conditions', () => { const f = fixture(); for (const item of (f.review.run.model.body as any).items)
    item.fields.scope.root = '0'.repeat(64); assert.ok(outcomes(f).some(o => o.verdict === 'unknown' && o.missing.includes('裁定'))); });
test('missing predecessor context and mismatching actual predecessor never synthesize history', () => { const f = fixture(); delete (f.subject.context as any).predecessor; assert.ok(outcomes(f).some(o => o.verdict === 'unknown' && o.missing.includes('前驱'))); const b = fixture(); b.record.predecessor = 'run_invented'; assert.ok(outcomes(b).some(o => o.code === 'recompose.atom_dropped')); });
test('all four source states, including settled continuation, require a complete named exit', () => { const f = fixture(); f.record.sources.states[0].exit = null; assert.ok(outcomes(f).some(o => o.code === 'recompose.missing_without_exit')); });
test('decision 155: a named gap stays in the record for the writer and does not hold the case back', () => { const f = fixture(); f.record.unknowns = [{ missing: '尚未给出前置事实', next_action: '补前置后重交', audience: '编写模型', due: '提交之前' }]; assert.ok(outcomes(f).every(o => o.verdict === 'support')); f.record.unknowns = [{ missing: '只写了缺什么' }] as any; assert.ok(outcomes(f).some(o => o.code === 'recompose.missing_without_exit')); });
test('unlisted method sources and missing actual declaration fragments cannot acquire authority', () => { const a = fixture(), ref = 'src:' + 'f'.repeat(64); a.record.contract.method.sources = [ref]; a.subject.evidence.push({ reference: ref, resolved: true, text: '存在但未声明' }); assert.ok(outcomes(a).some(o => o.code === 'recompose.candidate_signed')); const b = fixture(); b.subject.evidence = []; assert.ok(outcomes(b).some(o => o.verdict === 'unknown' && o.missing.includes('可读'))); });
test('a reference the record cannot be read by names its place, its value, what may stand there and who changes it', () => {
    const f = fixture();
    const [first] = f.record.atoms;
    f.record.contract.method.sources = ['客户端查询', first.quote_ref, 'src:' + 'f'.repeat(64) + '/json@1/p/none'];
    f.record.expectation_slots[0].evidence = ['客户端查询'];
    f.subject.evidence = f.subject.evidence.filter((e: any) => e.reference !== 'src:' + 'f'.repeat(64) + '/json@1/p/none');
    const rows = outcomes(f).filter(o => o.verdict === 'unknown');
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const [words, outside] = rows;
    for (const row of rows) {
        assert.equal(row.reason, 'missing_input');
        assert.equal(row.data.owner, '重组模型');
        assert.ok(row.missing.includes('fields.atoms[].reference'), row.missing);
        assert.ok(row.missing.includes('tree:' + f.context.root + '/'), row.missing);
        assert.ok(row.missing.includes('重新提交'), row.missing);
        assert.doesNotMatch(row.missing, /来源维护者/);
        assert.equal(row.statement, row.missing);
    }
    assert.ok(words.missing.includes('method.sources 第 1 项、slots（atom=a2）的 evidence 第 1 项 的值「客户端查询」'), words.missing);
    assert.equal(words.pointer, '/record/contract/method/sources/0');
    assert.deepEqual(words.data.places, ['/record/contract/method/sources/0', '/record/expectation_slots/0/evidence/0']);
    assert.ok(outside.missing.includes('method.sources 第 3 项 的值「src:' + 'f'.repeat(64) + '/json@1/p/none」'), outside.missing);
});
test('a record that cites its own sentences and the locked tree by reference draws no unreadable-reference refusal', () => {
    const f = fixture();
    (f.subject as any).authority_run = undefined;
    (f.subject as any).authority_result = undefined;
    f.record.sources.governing = [];
    for (const state of f.record.sources.states) state.adjudicated_by = null;
    f.record.contract.method.sources = [f.record.atoms[0].quote_ref, f.record.atoms[1].quote_ref, 'tree:' + f.context.root + '/commands/widget@' + '1'.repeat(64)];
    assert.deepEqual(outcomes(f).map(o => o.verdict), ['support'], JSON.stringify(outcomes(f)));
});
test('conflict requires two genuinely different closed declarations and current independent scope', () => { const a = fixture('conflict'); a.authority.governing[1].constraints = structuredClone(a.authority.governing[0].constraints); assert.ok(outcomes(a).some(o => o.verdict === 'refute' && o.statement.includes('完全相等'))); const b = fixture('conflict'); b.subject.review_run = { ...b.review.run, meta: null } as any; assert.ok(outcomes(b).some(o => o.verdict === 'unknown' && o.missing.includes('独立裁定'))); });
test("a user's ruling on an author step against the manual is carried by the fields a record already has, and waiting for one is an underdetermined atom", () => {
  const ruled = fixture();
  for (const state of ruled.record.sources.states) state.adjudicated_by = null;
  ruled.record.sources.states[0].reason = '用户裁定：以手册为准，改成手册允许的写法';
  ruled.record.ledgers.adapted[0].equivalence_reason = '用户裁定：以手册为准，改成手册允许的写法';
  const declaration = ruled.authority.values[0], ref = declaration.ref + '/values/0';
  ruled.record.ledgers.concretizations = [{ atom: 'a1', slot: declaration.slot, value: 5, value_ref: ref, source_of_value: declaration.ref, source_kind: 'catalog', decided_by: '用户', authority: declaration.ref }];
  ruled.subject.evidence.push({ reference: ref, resolved: true, text: '5' }, { reference: declaration.ref, resolved: true, text: '合成声明' });
  assert.deepEqual(outcomes(ruled).map(o => o.verdict), ['support'], JSON.stringify(outcomes(ruled)));

  const waiting = fixture();
  for (const state of waiting.record.sources.states) state.adjudicated_by = null;
  Object.assign(waiting.record.sources.states[0], { state: 'underdetermined', reason: '用户裁定：保留作者原样，这条先不编，待作者裁定' });
  waiting.record.unknowns = [{ missing: '作者步骤与手册冲突：合成', next_action: '作者或用户裁定', audience: '作者或用户', due: '交付之前' }];
  assert.deepEqual(outcomes(waiting).map(o => o.verdict), ['support'], JSON.stringify(outcomes(waiting)));

  const conflict = fixture();
  for (const state of conflict.record.sources.states) state.adjudicated_by = null;
  conflict.record.sources.states[0].state = 'conflict';
  assert.ok(outcomes(conflict).some(o => o.verdict === 'refute' && o.code === 'recompose.candidate_signed'), JSON.stringify(outcomes(conflict)));
});

test('adapted catalog and syntax errors emit repairable recompose.command_syntax while unchecked or absent catalog stays unknown', () => {
  for (const [label, line, expectedKind, expectedPiece] of [
    ['typed placeholder in string slot', 'widget health interval <arg1:string> 5', 'template_placeholder', '<arg1:string>'],
    ['quoted Chinese placeholder', 'widget pool add "<域名>"', 'template_placeholder', '"<域名>"'],
    ['unreplaced multi-placeholder', 'widget pool add <arg1:string> [extra]', 'template_placeholder', '<arg1:string>'],
    ['invalid argument for matched command', 'widget health interval pool1 not-an-int', 'signature_mismatch', 'not-an-int'],
    ['missing trailing required argument', 'widget health interval pool1', 'signature_mismatch', 'int'],
    ['excess argument after complete signature', 'widget health interval pool1 5 extra', 'signature_mismatch', 'extra'],
    ['unknown command head in complete catalog', 'nonexistent subcmd 1', 'unknown_command_head', 'nonexistent'],
  ] as const) {
    const f = fixture();
    (f.subject as any).catalog = { ...f.subject.catalog, complete: true };
    f.record.ledgers.adapted[0].commands = [line];
    const out = outcomes(f);
    const hit = out.find(o => o.code === 'recompose.command_syntax');
    assert.ok(hit, `${label}: expected recompose.command_syntax, got ${JSON.stringify(out)}`);
    assert.equal(hit.verdict, 'refute');
    assert.equal(hit.pointer, '/record/ledgers/adapted/0/commands/0');
    assert.equal(hit.data?.owner, '重组模型');
    assert.equal(hit.data?.determination, 'error');
    assert.equal(hit.data?.reason_kind, expectedKind);
    assert.ok(hit.statement.includes(line) && hit.statement.includes(f.record.ledgers.adapted[0].atom) && hit.statement.includes(expectedPiece), hit.statement);
    assert.ok(hit.statement.includes('第 1 条命令'), hit.statement);
    if (expectedKind === 'signature_mismatch') {
      if (expectedPiece === 'extra') {
        assert.ok(hit.statement.includes('不接受多余参数'), JSON.stringify(hit));
      } else {
        assert.ok(hit.statement.includes('要求 int') && Array.isArray(hit.data?.expected_types) && hit.data.expected_types.some((t: string) => t.startsWith('int')), JSON.stringify(hit));
      }
    }
    if (expectedKind === 'template_placeholder') {
      assert.ok(!hit.statement.includes('；请改写为'), hit.statement);
    }
  }

  const unchecked = fixture();
  unchecked.subject.catalog.entries[2].signatures[0].params = [{
    name: 'pool',
    type: undefined as any,
    native_type: { name: 'synthetic-raw', declaration: 'src:' + 'b'.repeat(64) + '/xml@1/x/arg', grammar: 'synthetic-tree@1' },
  }];
  unchecked.record.ledgers.adapted[0].commands = ['widget pool add pool1'];
  const uncheckedOut = outcomes(unchecked);
  assert.ok(!uncheckedOut.some(o => o.code === 'recompose.command_syntax'), JSON.stringify(uncheckedOut));
  assert.ok(uncheckedOut.some(o => o.verdict === 'unknown' && o.data?.owner === '产品包作者'), JSON.stringify(uncheckedOut));
  const commandGap = uncheckedOut.find(o => o.verdict === 'unknown' && o.pointer === '/record/ledgers/adapted/0/commands/0');
  assert.ok(commandGap, JSON.stringify(uncheckedOut));
  assert.match(commandGap.statement, /。下一步由模型改正重组记录后重交$/, 'the pack names who acts next, so the reader is not sent to the user');
  assert.equal(commandGap.data?.next_action, '由模型改正重组记录后重交');

  const emptyCatalog = fixture();
  emptyCatalog.subject.catalog = { root: 'b'.repeat(64), entries: [] };
  const emptyOut = outcomes(emptyCatalog);
  assert.ok(!emptyOut.some(o => o.code === 'recompose.command_syntax'), JSON.stringify(emptyOut));
  assert.ok(emptyOut.some(o => o.verdict === 'unknown' && o.data?.owner === '产品包作者'), JSON.stringify(emptyOut));

  const valid = fixture();
  const baseDecl = (valid.auth.run.model.body as any).groups[0].authority.values[0];
  const poolRef = baseDecl.ref + '/pool';
  (valid.auth.run.model.body as any).groups[0].authority.values.push({
    ...baseDecl,
    ref: poolRef,
    slot: 'pool',
    values: ['192.0.2.10', '{{name:16}}'],
  });
  valid.record.ledgers.adapted[0].commands = ['widget health interval pool1 5', 'widget pool add "192.0.2.10"', 'widget pool add {{name:16}}'];
  valid.record.ledgers.concretizations.push(
    { atom: 'a1', slot: 'pool', value: '192.0.2.10', value_ref: poolRef + '/0', source_of_value: poolRef, source_kind: 'catalog', decided_by: 'scripted-model', authority: poolRef },
    { atom: 'a1', slot: 'pool', value: '{{name:16}}', value_ref: poolRef + '/1', source_of_value: poolRef, source_kind: 'catalog', decided_by: 'scripted-model', authority: poolRef },
  );
  valid.subject.evidence.push(
    { reference: poolRef, resolved: true, text: '192.0.2.10, {{name:16}}' },
    { reference: poolRef + '/0', resolved: true, text: '192.0.2.10' },
    { reference: poolRef + '/1', resolved: true, text: '{{name:16}}' },
  );
  assert.deepEqual(outcomes(valid).map(o => o.verdict), ['support'], JSON.stringify(outcomes(valid)));
});
