// quote@1 reads any fragment of a source bound to the run, parsed by the boundary's own parser — also when the
// reference appears only deep inside slot data (the real defect-to-case shape: expected texts quote src fragments that
// the boundary never resolves because they sit in data, not in a quotes array). Verbatim passes; a wrong quote, a
// source that is not an input of this run and a selector that resolves to nothing are refuted; one reference is parsed
// once per evaluation. The retain-only and over-cap grades are covered at the interpreter level (quote.grades.test.ts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { INDEX } from './store.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async function beforeHook() {
  postgres = await startPostgres();
});
after(async function afterHook() {
  await postgres?.stop();
});

/** The expected texts of the standard document's cases (each case's expected subnode, id suffix e0). */
const EXPECTED: Record<string, string> = { c1: '3 区开始浇灌，15 分钟后停止', c2: '列出 8 个分区的状态' };

/** Submit a run whose c4 findings slot carries the quote deep in data (data.expected_quote). */
const submitQuote = async (h: Harness, map: string, quote: { text: string; reference: string }, notes?: string, afterBind?: () => void) => {
  const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map }, ...(notes ? { notes: [{ reference: notes }] } : {}) } }, h.call())).run!;
  afterBind?.();
  const reference = quote.reference === '@c2expected'
    ? expectedRef(map, run).replace('c1aaaaaaaaaae0','c2bbbbbbbbbbe0')
    : quote.reference === '@c1expected' ? expectedRef(map, run) : quote.reference;
  // The top-level quotes row carries a boundary-resolvable reference (the slot rule wants one); the data row is the
  // one under test — its reference never passes through the boundary.
  const topLevel = expectedRef(map, run);
  const submission = {
      run: run.run,
      model: 'aster-7',
      items: [
        { item: ITEM.c1, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c3, handling: 'handled', slots: { findings: [] } },
        { item: ITEM.c4, handling: 'handled', slots: { findings: [{ text: '期望来源引文', code: 'edge_case_gap', rank: 'major', quotes: [{ reference: topLevel, text: EXPECTED.c1 }], data: { expected_quote: { text: quote.text, reference } } }] } },
      ],
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    };
  const answer = await h.service.submitResult(h.alice,submission,h.call());
  return {answer,run,submission};
};
/** Accepted validation helper; Hub-failure cases inspect submitQuote directly. */
const quoteRun = async (...args:Parameters<typeof submitQuote>) => {
  const {answer}=await submitQuote(...args);
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const row = Object.values(answer.result!.partitions).flat().find((it) => it.item === ITEM.c4)!;
  return row.requirements.find((r) => r.requirement === 'findings')!;
};

/** c1's expected-subnode reference, derived from the started run's own item location (the id suffix e0, reuse's shape). */
const expectedRef = (map: string, run: { items: Array<{ id: string; location: string }> }): string => {
  const at = run.items.find((i) => i.id === ITEM.c1)!.location;
  return at.replace(/c1aaaaaaaaaa$/, 'c1aaaaaaaaaae0');
};

const open = async (): Promise<{ h: Harness; map: string }> => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  return { h, map };
};

test('a quote that appears only in slot data is checked against the bound source: verbatim passes', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: EXPECTED.c2, reference: '@c2expected' });
    // The requirement is an independent judgment: its static layer is a judgment; the two quote checks (the boundary's
    // and the slot-data one) each support — the second proves the data-only reference was read and matched.
    const quoteSupports = findings.claims.filter((c) => c.statement.verdict === 'support' && JSON.stringify(c.statement.data ?? {}).includes('逐字') === false && (c.statement.text ?? '').includes('逐字一致'));
    assert.equal(quoteSupports.length, 2, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.ok(findings.claims.every((c) => c.statement.verdict !== 'refute' && c.statement.verdict !== 'unknown'), JSON.stringify(findings.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('the same slot-data quote, not verbatim, is refuted with QUOTE_MISMATCH', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: `${EXPECTED.c2}？`, reference: '@c2expected' });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    assert.ok(findings.claims.some((c) => c.statement.verdict === 'refute' && (c.statement as { code?: string }).code === 'QUOTE_MISMATCH'), JSON.stringify(findings.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('a quote whose source is not an input of this run is refuted', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `src:${'f'.repeat(64)}/kityminder@1/n/docq7/c1aaaaaaaaaa` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute')!;
    assert.match(refute.statement.text, /不是这次运行的输入/);
    assert.equal(refute.statement.code,'QUOTE_MISMATCH');
    assert.equal(refute.statement.data?.why,'not_bound');
  } finally {
    await h.close();
  }
});

test('a selector that resolves to no fragment of a bound source is refuted as 片段不存在', { skip }, async () => {
  const { h, map } = await open();
  try {
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `${map}/kityminder@1/n/docq7/nope` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute')!;
    assert.match(refute.statement.text, /片段不存在/);
    assert.equal(refute.statement.code,'QUOTE_MISMATCH');
    assert.equal(refute.statement.data?.why,'no_fragment');
  } finally {
    await h.close();
  }
});

test('two data-only quote rows over one reference resolve once per evaluation', { skip }, async t => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const started = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
    const reference = expectedRef(map, started);
    const dataReference = `tree:${ROOTS.meadow329}/zone/set`;
    const treeReader = h.knowledge.treeReader();
    let reads = 0;
    t.mock.method(h.knowledge,'treeReader',()=>({...treeReader,read:(...args:Parameters<typeof treeReader.read>)=>{
      if (args[0] === ROOTS.meadow329 && args[1] === '/zone/set') reads++;
      return treeReader.read(...args);
    }}));
    const answer = await h.service.submitResult(
      h.alice,
      {
        run: started.run,
        model: 'aster-7',
        items: [
          { item: ITEM.c1, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c3, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c4, handling: 'handled', slots: { findings: [
            { text: '期望来源引文一', code: 'edge_case_gap', rank: 'major', quotes: [{ reference, text: EXPECTED.c1 }], data: { expected_quote: { text: '命令 zone set', reference: dataReference } } },
            { text: '期望来源引文二', code: 'coverage_gap', rank: 'major', quotes: [{ reference, text: EXPECTED.c1 }], data: { expected_quote: { text: '命令 zone set', reference: dataReference } } },
          ] } },
        ],
        cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
      },
      h.call(),
    );
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const row = Object.values(answer.result!.partitions).flat().find((it) => it.item === ITEM.c4)!;
    // Both rows over the one reference are checked (four quote supports: two rows x two checks) with no refute or
    // unknown — one parse served them all.
    const findings = row.requirements.find((r) => r.requirement === 'findings')!;
    const quoteSupports = findings.claims.filter((c) => c.statement.verdict === 'support' && (c.statement.text ?? '').includes('逐字一致'));
    assert.equal(reads,1,'the data-only reference is resolved once across both rows and checks');
    assert.equal(quoteSupports.length, 4, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.ok(findings.claims.every((c) => c.statement.verdict !== 'refute' && c.statement.verdict !== 'unknown'));
  } finally {
    await h.close();
  }
});

test('a tree reference whose root is the run\'s locked root is checked: verbatim passes, wrong quote refutes', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    // The harness locks line 3.2: its newest build's root (FakeKnowledge ROOTS.meadow329).
    const lockedRoot = ROOTS.meadow329;
    const treeRef = `tree:${lockedRoot}/zone/set`;
    // The fake tree reader answers the text 命令 zone set for a catalog path; quote it verbatim.
    const findings = await quoteRun(h, map, { text: '命令 zone set', reference: treeRef });
    assert.equal(findings.claims.filter(c => c.statement.verdict === 'support' && c.statement.text.includes('逐字一致')).length,2);
    assert.ok(!findings.claims.some(c => c.statement.verdict === 'refute' || c.statement.verdict === 'unknown'));
    const bad = await quoteRun(h, map, { text: '命令 zone set？', reference: treeRef });
    assert.ok(bad.claims.some((c) => c.statement.verdict === 'refute' && (c.statement as { code?: string }).code === 'QUOTE_MISMATCH'), JSON.stringify(bad.claims.map((c) => c.statement)));
  } finally {
    await h.close();
  }
});

test('a tree reference whose root is not the run\'s locked root is refuted', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const otherRoot = ROOTS.grove105;
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `tree:${otherRoot}/zone/set` });
    const refute = findings.claims.find((c) => c.statement.verdict === 'refute');
    assert.ok(refute !== undefined, JSON.stringify(findings.claims.map((c) => c.statement)));
    assert.match(refute.statement.text, /不是这次运行的输入/);
    assert.equal(refute.statement.code,'QUOTE_MISMATCH');
    assert.equal(refute.statement.data?.why,'not_bound');
  } finally {
    await h.close();
  }
});

test('an out of scope record reference is refuted with a binding remedy', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, dataQuotes: true });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    // An unresolvable rec: reference stays unknown (missing input), never a refutation.
    const stranger = 'e'.repeat(64);
    const findings = await quoteRun(h, map, { text: '随便什么文字', reference: `rec:${stranger}#/body/x` });
    const layer = findings.layers.find((l) => l.layer === 'static')!;
    assert.equal(layer.terminal, 'violation', JSON.stringify(findings.layers));
    assert.ok(findings.claims.some(c => c.statement.code === 'QUOTE_MISMATCH'));
    assert.ok(findings.claims.some(c => c.statement.verdict === 'refute' && c.statement.data?.why === 'not_bound'));
    const unknown = findings.claims.find((c) => c.statement.verdict === 'refute');
    assert.ok(unknown !== undefined && /取不回|不可读|没有绑定|不是这次运行的输入/.test(unknown.statement.text), JSON.stringify(unknown?.statement));
  } finally {
    await h.close();
  }
});


test('a readable record outside the run is refuted even when the quote matches', { skip }, async t => {
  const {h,map}=await open(); t.after(()=>h.close());
  const owner=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call());
  assert.ok(owner.run);
  const record=await h.kit.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{run:owner.run.run,text:'合成记录片段'}});
  const reference=`rec:${record.digest}#/text`;
  for (const text of ['合成记录片段', '记录中没有的文字']) {
    const result = await quoteRun(h, map, { text, reference });
    assert.ok(result.claims.some(c => c.statement.verdict === 'refute' && c.statement.data?.why === 'not_bound'));
    assert.ok(!result.claims.some(c => c.statement.verdict === 'unknown'));
  }
});

test('bound action records are checked but bound run records cannot serve as grounds', { skip }, async t => {
  const { h, map } = await open(); t.after(() => h.close());
  h.review.workflow.inputs.find(i => i.slot === 'notes')!.accepts.push('application/json');
  const owner = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  const action = await h.kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', body: { run: owner.run, text: '合成记录片段' } });
  const reference = `rec:${action.digest}#/text`;
  const good = await quoteRun(h, map, { text: '合成记录片段', reference }, `rec:${action.digest}`);
  assert.equal(good.claims.filter(c => c.statement.verdict === 'support' && c.statement.text.includes('逐字一致')).length, 2);
  const wrong = await quoteRun(h, map, { text: '记录中没有的文字', reference }, `rec:${action.digest}`);
  assert.ok(wrong.claims.some(c => c.statement.verdict === 'refute' && c.statement.code === 'QUOTE_MISMATCH'));
  const missing = await quoteRun(h, map, { text: '合成', reference: `rec:${action.digest}#/absent` }, `rec:${action.digest}`);
  assert.ok(missing.claims.some(c => c.statement.verdict === 'refute' && c.statement.data?.why === 'no_fragment'));
  const malformed = await quoteRun(h, map, { text: '合成', reference: 'src:bad' });
  assert.ok(malformed.claims.some(c => c.statement.verdict === 'refute' && c.statement.data?.why === 'malformed'));
  const stored = await h.kit.store.find({ key: 'runs.id', value: owner.run, kind: 'run' });
  const runRef = `rec:${stored.items[0].digest}`;
  const forbidden = await quoteRun(h, map, { text: owner.run, reference: `${runRef}#/run` }, runRef);
  assert.ok(forbidden.claims.some(c => c.statement.verdict === 'refute' && c.statement.data?.why === 'not_groundable'));
  assert.ok(!forbidden.claims.some(c => c.statement.verdict === 'unknown'));
});

test('standalone knowledge entries require a tree address', { skip }, async t => {
  const {h,map}=await open(); t.after(()=>h.close());
  const entry='d'.repeat(64),treeReader=h.knowledge.treeReader();
  t.mock.method(h.knowledge,'treeReader',()=>({...treeReader,readEntry:(sha:string)=>sha===entry
    ? {text:'合成条目原文',mediaType:'text/plain',readTier:'model_readable' as const,grounds:[]}
    : null}));
  const good=await quoteRun(h,map,{text:'合成条目原文',reference:`entry:${entry}`});
  assert.ok(good.claims.some(c=>c.statement.verdict==='refute' && c.statement.data?.why==='entry_unaddressed'));
  assert.ok(!good.claims.some(c=>c.statement.verdict==='unknown'));
  const missing=await quoteRun(h,map,{text:'合成条目原文',reference:`entry:${'c'.repeat(64)}`});
  assert.ok(missing.claims.some(c=>c.statement.verdict==='refute'));
  assert.ok(!missing.claims.some(c=>c.statement.verdict==='unknown'));
});

test('resolver codes refute parser and range failures even when the message never says 找不到', { skip }, async t => {
  const {h,map}=await open(); t.after(()=>h.close());
  for (const reference of [`${map}/absent@1/n/docq7/nope`,`${map}/kityminder@1/n/docq7/c1aaaaaaaaaae0:0-999999`]) {
    const result=await quoteRun(h,map,{text:'任意引文',reference});
    const refute=result.claims.find(c=>c.statement.verdict==='refute');
    assert.ok(refute);
    assert.equal(refute.statement.code,'QUOTE_MISMATCH');
    assert.equal(refute.statement.data?.why,'no_fragment');
    assert.match(refute.statement.text,/片段不存在/);
  }
});

test('a locked tree preserves retained/empty grades and automatically recovers temporary read failures', { skip }, async t => {
  const {h,map}=await open(); t.after(()=>h.close());
  const treeReader=h.knowledge.treeReader();
  let offlineReads=0;
  t.mock.method(h.knowledge,'treeReader',()=>({...treeReader,hasRoot:()=>true,read:(...args:Parameters<typeof treeReader.read>)=>{
    if (args[1] === '/empty') return {text:null,mediaType:'application/octet-stream',readTier:'model_readable' as const,grounds:[]};
    if (args[1] === '/held') return {text:null,mediaType:'text/plain',readTier:'retain_only' as const,grounds:[]};
    if (args[1] === '/offline') { if(++offlineReads < 3) throw new Error('合成读取失败'); return {text:'任意引文',mediaType:'text/plain',readTier:'model_readable' as const,grounds:[]}; }
    if (args[1] === '/missing') return null;
    return treeReader.read(...args);
  }}));
  for (const [path,message] of [['/held',/含凭据，原文不可读/]] as const) {
    const result=await quoteRun(h,map,{text:'任意引文',reference:`tree:${ROOTS.meadow329}${path}`});
    assert.ok(!result.claims.some(c=>c.statement.verdict==='refute'));
    assert.ok(result.claims.some(c=>c.statement.verdict==='unknown' && message.test(c.statement.text)));
  }
  const recovered=await quoteRun(h,map,{text:'任意引文',reference:`tree:${ROOTS.meadow329}/offline`});
  assert.equal(offlineReads,3);
  assert.ok(!recovered.claims.some(c=>c.statement.verdict==='unknown'||c.statement.verdict==='refute'));
  const empty=await quoteRun(h,map,{text:'任意引文',reference:`tree:${ROOTS.meadow329}/empty`});
  assert.ok(empty.claims.some(c=>c.statement.verdict==='refute' && c.statement.data?.why==='no_fragment'));
  const missing=await quoteRun(h,map,{text:'任意引文',reference:`tree:${ROOTS.meadow329}/missing`});
  const refute=missing.claims.find(c=>c.statement.verdict==='refute');
  assert.ok(refute);
  assert.equal(refute.statement.code,'QUOTE_MISMATCH');
  assert.equal(refute.statement.data?.why,'no_fragment');
});


test('valid data-only references longer than 600 characters use the boundary length limit', { skip }, async t => {
  const {h,map}=await open(); t.after(()=>h.close());
  const reference=`tree:${ROOTS.meadow329}/${'long'.repeat(170)}`;
  assert.ok(reference.length > 600);
  const result=await quoteRun(h,map,{text:'知识树',reference});
  assert.equal(result.claims.filter(c=>c.statement.verdict==='support' && c.statement.text.includes('逐字一致')).length,2);
  assert.ok(!result.claims.some(c=>c.statement.verdict==='refute'||c.statement.verdict==='unknown'));
});

test('a corrupted bound record preserves the integrity cause through Hub retry refusal and restoration', { skip }, async t => {
  const { h, map } = await open(); t.after(() => h.close());
  h.review.workflow.inputs.find(i => i.slot === 'notes')!.accepts.push('application/json');
  const owner = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  const action = await h.kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', body: { run: owner.run, text: '合成记录片段' } });
  const original = h.kit.store.get.bind(h.kit.store);
  let tampered = false;
  t.mock.method(h.kit.store, 'get', async (digest: string) => {
    const record = await original(digest);
    return tampered && record !== null && digest === action.digest ? { ...record, body: { ...(record.body as object), text: '被改动的合成字节' } } : record;
  });
  const {answer,run,submission} = await submitQuote(h, map, { text: '合成记录片段', reference: `rec:${action.digest}#/text` }, `rec:${action.digest}`, () => { tampered = true; });
  assert.equal(answer.call_result,'error');assert.equal(answer.acceptance,'not_accepted');assert.equal(answer.result,undefined);
  assert.deepEqual(answer.errors.map(e=>e.code),['SOURCE_UNAVAILABLE']);
  assert.ok(answer.errors.every(e=>e.rounds_left===undefined && e.requirement===undefined));
  assert.match(answer.errors[0].fix ?? '',/管理员.*恢复.*原样重交.*不计修复轮/);
  const actions=(await h.kit.store.find<ActionBody>({key:INDEX.actionRun,value:run.run,kind:'action'})).items.filter(r=>r.body.action==='validate');
  assert.equal(actions.length,1);const failed=actions[0].body;
  assert.equal(failed.result,'error');assert.equal(failed.error_code,'integrity_unproven');assert.equal(failed.acceptance,null);
  assert.equal(failed.detail.hub_error,true);assert.equal(failed.detail.reason,'integrity_unproven');assert.deepEqual(failed.detail.repair,[]);
  const attempts=(failed.detail.retry_attempts as Array<Record<string,unknown>>).filter(a=>a.operation==='read');
  assert.deepEqual(attempts.map(a=>a.attempt),[1,2,3]);
  assert.equal((await h.kit.store.find({key:INDEX.resultRun,value:run.run,kind:'validation_result'})).items.length,0);
  tampered=false;
  const restored=await h.service.submitResult(h.alice,submission,h.call());
  assert.equal(restored.acceptance,'accepted',JSON.stringify(restored.errors));assert.equal(restored.result?.rounds.used,0);

});
