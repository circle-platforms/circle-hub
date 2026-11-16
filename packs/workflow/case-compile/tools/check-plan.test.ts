import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fidelityBrief } from '../functions/fidelity.ts';
import { main } from './check-plan.ts';

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(argv), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function flatPlan(item = 'doc:case-1', args: string[] = ['widget health interval {{name:12|p_|_s}}']) {
  return {
    item,
    handling: 'handled',
    slots: {
      plan: [
        {
          text: '合成计划',
          quotes: [{ reference: `src:${'a'.repeat(64)}/kityminder@1/n/exp`, text: '健康检查设置成功' }],
          data: {
            bucket: 'bed-a',
            blocks: [],
            replacements: [],
            steps: [
              { object: 'widget-seat', method: 'configure', args, keywords: {} },
              { object: 'widget-seat', method: 'configure', args: ['no widget health'], keywords: {}, cleanup: true },
            ],
            expects: [
              {
                text: '健康检查设置成功',
                quote: { reference: `src:${'a'.repeat(64)}/kityminder@1/n/exp`, text: '健康检查设置成功' },
                after: 1,
              },
            ],
          },
        },
      ],
    },
  };
}

function b1Plan(item = 'doc:case-b1') {
  const quote = { reference: `src:${'a'.repeat(64)}/kityminder@1/n/exp`, text: 'OK' };
  return {
    item,
    handling: 'handled',
    slots: {
      plan: [
        {
          text: '合成 B1 块状计划',
          quotes: [quote],
          data: {
            bucket: 'bed-a',
            steps: [],
            expects: [],
            replacements: [],
            block_context: { preconditions: [], causal_links: [{ from: 'b1', to: 'observe', quote }], responders: [] },
            criteria: [],
            obligations: [{ expectation: quote.reference, status: 'asserted', assertions: ['a1'] }],
            blocks: [
              {
                id: 'b1',
                kind: 'CONFIG',
                call: { object: 'widget-seat', method: 'configure', args: ['widget health {{domain:253}}'], keywords: {} },
              },
              {
                id: 'observe',
                kind: 'OBSERVE_ASSERT',
                call: { object: 'widget-seat', method: 'show', args: ['show widget'], keywords: {} },
                assertions: [
                  {
                    id: 'a1',
                    output: 'observe',
                    op: 'abs_found',
                    literal: 'OK',
                    quote,
                    expectation: quote.reference,
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

test('valid flat and B1 block plans expand length placeholders in memory without modifying disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-plan-'));
  try {
    const flatFile = join(dir, 'flat.json');
    const b1File = join(dir, 'b1.json');
    const flatRaw = JSON.stringify(flatPlan('doc:a', ['widget host {{domain:253}}']), null, 2);
    const b1Raw = JSON.stringify(b1Plan('doc:b'), null, 2);
    await writeFile(flatFile, flatRaw, 'utf8');
    await writeFile(b1File, b1Raw, 'utf8');

    const flatRes = await runCli(['--file', flatFile]);
    assert.equal(flatRes.code, 1, flatRes.stderr);
    const flatReport = JSON.parse(flatRes.stdout);
    assert.deepEqual([flatReport.structure_ok, flatReport.kind, flatReport.counts.steps, flatReport.counts.cleanup_steps, flatReport.counts.expects], [true, 'flat', 2, 1, 1]);
    assert.equal(flatReport.expansions.length, 1);

    const nameRes = await runCli(['--file', b1File]);
    assert.equal(nameRes.code, 1, nameRes.stderr);
    const b1Report = JSON.parse(nameRes.stdout);
    assert.deepEqual([b1Report.structure_ok, b1Report.kind, b1Report.counts.blocks], [true, 'blocks', 2]);

    // Read-only guarantee: byte-for-byte unchanged on disk.
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(flatFile, 'utf8'), flatRaw);
    assert.equal(await readFile(b1File, 'utf8'), b1Raw);

    // {{name:64}} also expands validly in memory.
    const nameFile = join(dir, 'name64.json');
    await writeFile(nameFile, JSON.stringify(flatPlan('doc:c', ['widget id {{name:64}}'])));
    const name64 = await runCli(['--file', nameFile]);
    assert.equal(name64.code, 1, name64.stderr);
    assert.equal(JSON.parse(name64.stdout).structure_ok,true);
    assert.equal(JSON.parse(name64.stdout).expansions.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skipped plans pass while broken UTF-8, invalid JSON, bad placeholders, and slot shape errors fail cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-bad-'));
  try {
    const skipped = join(dir, 'skip.json');
    await writeFile(skipped, JSON.stringify({ item: 'doc:s', handling: 'skipped', reason: '缺前置条件' }));
    const skipRes = await runCli(['--file', skipped]);
    assert.equal(skipRes.code, 0, skipRes.stderr);
    assert.equal(JSON.parse(skipRes.stdout).kind, 'skipped');

    const badUtf8 = join(dir, 'utf8.json');
    await writeFile(badUtf8, Buffer.from([0xff, 0xfe, 0x00]));
    const utf8Res = await runCli(['--file', badUtf8]);
    assert.equal(utf8Res.code, 1);
    assert.match(utf8Res.stderr, /^参数无效：/);

    const badJson = join(dir, 'broken.json');
    await writeFile(badJson, '{"item": ');
    const jsonRes = await runCli(['--file', badJson]);
    assert.equal(jsonRes.code, 1);
    assert.match(jsonRes.stderr, /^参数无效：/);

    const badPh = join(dir, 'bad-placeholder.json');
    await writeFile(badPh, JSON.stringify(flatPlan('doc:ph', ['widget host {{domain:5000}}'])));
    const phRes = await runCli(['--file', badPh]);
    assert.equal(phRes.code, 1);
    assert.equal(JSON.parse(phRes.stdout).ok, false);
    assert.match(phRes.stderr, /^参数无效：/);

    const syntaxPh = join(dir, 'syntax-placeholder.json');
    await writeFile(syntaxPh, JSON.stringify(flatPlan('doc:ph2', ['widget host {{domain:abc}}'])));
    const syntaxPhRes = await runCli(['--file', syntaxPh]);
    assert.equal(syntaxPhRes.code, 1);
    assert.match(syntaxPhRes.stderr, /^参数无效：/);

    const badHandling = join(dir, 'bad-handling.json');
    await writeFile(badHandling, JSON.stringify({ item: 'doc:bad-h', handling: 'unknown_mode' }));
    const handlingRes = await runCli(['--file', badHandling]);
    assert.equal(handlingRes.code, 1);
    const handlingOut = JSON.parse(handlingRes.stdout);
    assert.equal(handlingOut.ok, false);
    assert.ok(handlingOut.problems.some((p: { pointer: string; message: string }) => p.pointer === '/handling' && p.message.includes('handled 或 skipped')));
    assert.match(handlingRes.stderr, /^参数无效：/);

    const badSlots = join(dir, 'bad-slots.json');
    const broken = flatPlan('doc:bad');
    (broken.slots.plan[0]!.data as Record<string, unknown>).extra_key = 123;
    await writeFile(badSlots, JSON.stringify(broken));
    const slotRes = await runCli(['--file', badSlots]);
    assert.equal(slotRes.code, 1);
    const slotOut = JSON.parse(slotRes.stdout);
    assert.equal(slotOut.ok, false);
    assert.ok(slotOut.problems.some((p: { pointer: string }) => p.pointer.includes('extra_key')));
    assert.match(slotRes.stderr, /^参数无效：/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('directory mode checks every plan file and catches duplicates with 已被占用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-dir-'));
  try {
    const emptyDir = join(dir, 'empty');
    await mkdir(emptyDir);
    const emptyRes = await runCli(['--file', emptyDir]);
    assert.equal(emptyRes.code, 1);
    assert.match(emptyRes.stderr, /^不存在：/);

    const okDir = join(dir, 'ok-plans');
    await mkdir(okDir);
    await writeFile(join(okDir, '01.json'), JSON.stringify(flatPlan('doc:1')));
    await writeFile(join(okDir, '02.json'), JSON.stringify(b1Plan('doc:2')));
    const okRes = await runCli(['--file', okDir]);
    assert.equal(okRes.code, 1, okRes.stderr);
    const okReport = JSON.parse(okRes.stdout);
    assert.deepEqual([okReport.mode, okReport.checked, okReport.passed, okReport.failed], ['directory', 2, 0, 2]);

    // Two plans the Hub accepts, so that the only problem is the duplicate: the frozen run carries what the Hub froze (the slot
    // schema, the lease view, the locked command tree downloaded beside it).
    const dupDir = join(dir, 'dup-plans');
    await mkdir(dupDir);
    const {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,QUOTE,goodData}=await import('../functions/test-support.ts');
    const {frozenRun,writeDownload}=await import('../testing/frozen-run.ts');
    const accepted=(item:string)=>({item,handling:'handled',slots:{plan:[{text:'合成计划',quotes:[QUOTE],data:goodData()}]}});
    await writeFile(join(dupDir, '01.json'), JSON.stringify(accepted('doc:dup')));
    await writeFile(join(dupDir, '02.json'), JSON.stringify(accepted('doc:dup')));
    const frozen=frozenRun({groups:[{kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC,leases:{now:'2026-10-23T02:00:00.000Z',entries:[]}}],items:[{id:'doc:dup',label:'合成',location:QUOTE.reference,fields:{}}],root:COMMAND_CATALOG.root,command_policy:COMMAND_CATALOG.policy});
    const run=await writeDownload(join(dir,'download'),frozen,COMMAND_CATALOG as never);
    const dupRes = await runCli(['--file', dupDir,'--run',run]);
    assert.equal(dupRes.code, 1);
    assert.match(dupRes.stderr, /^已被占用：/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verdict mode checks .verdict.json standalone and against --brief for fidelity problems', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-verdict-'));
  try {
    const plan = flatPlan('doc:v');
    const record = {
      record: `rec:${'c'.repeat(64)}`,
      item: 'doc:v',
      atoms: [
        { id: '1', kind: 'action', text: '配置健康检查' },
        { id: '2', kind: 'action', text: '清理配置' },
      ],
      ledgers: { original: [], adapted: [] },
      method: 'direct',
    };
    const brief = fidelityBrief('doc:v', record, plan.slots.plan[0]!.data);
    assert.ok(brief !== null);
    const briefPath = join(dir, '00.brief.json');
    await writeFile(briefPath, JSON.stringify(brief, null, 2));

    const validVerdict = {
      disclosure: '已保真核对。',
      steps: [
        { n: '1', verdict: 'preserved', step_indices: [1], rationale: '第 1 步覆盖配置动作' },
        { n: '2', verdict: 'preserved', step_indices: [2], rationale: '第 2 步覆盖清理动作' },
      ],
    };
    const okVerdictPath = join(dir, '00.verdict.json');
    await writeFile(okVerdictPath, JSON.stringify(validVerdict));

    const standaloneOk = await runCli(['--file', okVerdictPath]);
    assert.equal(standaloneOk.code, 0, standaloneOk.stderr);
    const pairedOk = await runCli(['--file', okVerdictPath, '--brief', briefPath]);
    assert.equal(pairedOk.code, 0, pairedOk.stderr);

    // Extra root key -> fidelity_shape
    const extraPath = join(dir, 'extra.verdict.json');
    await writeFile(extraPath, JSON.stringify({ ...validVerdict, extra: true }));
    const extraRes = await runCli(['--file', extraPath, '--brief', briefPath]);
    assert.equal(extraRes.code, 1);
    assert.equal(JSON.parse(extraRes.stdout).problems[0].code, 'fidelity_shape');

    // Empty step_indices for preserved -> author_step_unbound
    const unboundPath = join(dir, 'unbound.verdict.json');
    await writeFile(
      unboundPath,
      JSON.stringify({
        ...validVerdict,
        steps: [
          { n: '1', verdict: 'preserved', step_indices: [], rationale: '未填步骤' },
          validVerdict.steps[1],
        ],
      }),
    );
    const unboundRes = await runCli(['--file', unboundPath, '--brief', briefPath]);
    assert.equal(unboundRes.code, 1);
    assert.equal(JSON.parse(unboundRes.stdout).problems[0].code, 'author_step_unbound');
    assert.equal((await runCli(['--file', unboundPath])).code, 1);

    // changed verdict -> scenario_changed
    const changedPath = join(dir, 'changed.verdict.json');
    await writeFile(
      changedPath,
      JSON.stringify({
        ...validVerdict,
        steps: [
          { n: '1', verdict: 'changed', step_indices: [1], rationale: '参数不一致' },
          validVerdict.steps[1],
        ],
      }),
    );
    const changedRes = await runCli(['--file', changedPath, '--brief', briefPath]);
    assert.equal(changedRes.code, 1);
    assert.equal(JSON.parse(changedRes.stdout).problems[0].code, 'scenario_changed');

    const withPlumbMetaPath = join(dir, 'with-meta.verdict.json');
    await writeFile(withPlumbMetaPath, JSON.stringify({
      ...validVerdict,
      model_disclosure: { status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0' },
      steps: [
        { ...validVerdict.steps[0], model_judgment: { status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', task: 'sequence', choice: '保持', confidence: 0.92 } },
        validVerdict.steps[1],
      ],
    }));
    assert.equal((await runCli(['--file', withPlumbMetaPath])).code, 0);
    assert.equal((await runCli(['--file', withPlumbMetaPath, '--brief', briefPath])).code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid CLI invocations fail with closed category format and never leak token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-args-'));
  try {
    for (const argv of [
      [],
      ['--file=a.json'],
      ['--hub', 'http://127.0.0.1:8080/mcp', '--file', 'a.json'],
      ['--file', join(dir, 'missing.json')],
    ]) {
      const res = await runCli(argv);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /^(参数无效|不存在|无权限|已被占用|暂时不可用)：.+\n$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-plan accepts valid precondition_source on flat steps and rejects malformed precondition_source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-check-precond-'));
  try {
    const validPath = join(dir, 'valid.json');
    await writeFile(
      validPath,
      JSON.stringify({
        item: 'doc:v',
        handling: 'handled',
        slots: {
          plan: [
            {
              text: '带手动手册前置引文',
              quotes: [{ reference: 'agile:mindmap:doc#e1', text: '期望响应' }],
              data: {
                bucket: 'bed-1',
                blocks: [],
                steps: [
                  {
                    object: 'apv0',
                    method: 'cmd_config',
                    args: ['synconfig peer 192.0.2.2'],
                    keywords: {},
                    description: '根据手册示例补齐本端对端地址',
                    precondition_source: {
                      reference: 'knowledge:manual#synconfig',
                      text: 'Configure peer IP on both nodes before running synconfig',
                    },
                  },
                ],
                expects: [{ text: '期望响应', quote: { reference: 'agile:mindmap:doc#e1', text: '期望响应' }, after: 1 }],
                replacements: [],
              },
            },
          ],
        },
      }),
    );
    const validRes = await runCli(['--file', validPath]);
    assert.equal(validRes.code, 1, validRes.stdout + validRes.stderr);
    assert.equal(JSON.parse(validRes.stdout).structure_ok,true);
    assert.deepEqual(JSON.parse(validRes.stdout).problems.map((p:any)=>p.code),['missing_input']);

    const invalidPath = join(dir, 'invalid.json');
    const badJson = JSON.parse(await readFile(validPath, 'utf8'));
    badJson.slots.plan[0].data.steps[0].precondition_source = { reference: 'knowledge:manual#synconfig', text: '' };
    await writeFile(invalidPath, JSON.stringify(badJson));
    const invalidRes = await runCli(['--file', invalidPath]);
    assert.equal(invalidRes.code, 1);
    assert.ok(JSON.parse(invalidRes.stdout).problems.some((p: { pointer: string }) => p.pointer.includes('/precondition_source')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T9: a syntax-only pass cannot claim the frozen authority boundary passed.
test('plan checks disclose missing frozen run and share Hub method refusal with --run',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'plan-frozen-'));
 try {
  const {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC}=await import('../functions/test-support.ts');
  const plan=flatPlan();const file=join(dir,'plan.json'),run=join(dir,'run.json');
  await writeFile(file,JSON.stringify(plan));
  const syntax=await runCli(['--file',file]);
  const syntaxResult=JSON.parse(syntax.stdout);assert.equal(syntaxResult.ok,false);assert.equal(syntaxResult.structure_ok,true);assert.equal(syntaxResult.authority_checked,false);assert.match(syntaxResult.disclosure,/冻结/);assert.match(syntax.stderr,/本地核对未通过/);assert.doesNotMatch(syntax.stderr,/结构检查未通过/);
  const {frozenRun}=await import('../testing/frozen-run.ts');
  await writeFile(run,JSON.stringify(frozenRun({groups:[{kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC}],items:[{id:plan.item}]})));
  plan.slots.plan[0].data.steps[0].object='invented-seat';await writeFile(file,JSON.stringify(plan));
  const checked=await runCli(['--file',file,'--run',run]);assert.equal(checked.code,1,checked.stderr);
  const result=JSON.parse(checked.stdout);assert.equal(result.authority_checked,true);
  assert.ok(result.problems.some((p:any)=>p.code==='case-compile.method_forbidden'&&p.requested.object==='invented-seat'&&p.allowed_calls.length>0));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI checks declared inverse before runner clear using only the matching downloaded knowledge root',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'plan-runner-cleanup-'));
 try{
  const {fixture,cleanup}=await import('../testing/inverse-alternatives.ts');const {runtimeDigest}=await import('../functions/runtime-contract.ts');
  const value=fixture(['demo switch on']);const contract=value.subject.contract as any;
  contract.cleanup={source:'fixture/clear',sha256:'a'.repeat(64),objects:['widget-seat'],rules:[{prefixes:['demo'],clears:['clear demo all']}]};contract.contract_sha256=runtimeDigest(contract);
  const catalog=value.subject.command_catalog as any,runId='run_synthetic_cleanup';
  const {frozenRun}=await import('../testing/frozen-run.ts');
  const run=frozenRun({run:runId,root:catalog.root,command_policy:catalog.policy,groups:[{kind:'case-compile',contract,profile:value.subject.profile,manifest:value.subject.manifest}],items:[{id:'synthetic-item'}]});
  // The Hub also asks every flat plan for an expectation with its source; the fixture only builds what the cleanup rule needs.
  const {QUOTE}=await import('../functions/test-support.ts');
  const withExpect=(data:any)=>({...data,expects:[{text:QUOTE.text,quote:{...QUOTE},after:1}]});
  const plan={item:'synthetic-item',handling:'handled',slots:{plan:[{text:'合成计划',data:withExpect(value.subject.data)}]}};
  const file=join(dir,'plan.json'),runFile=join(dir,'run.json');await writeFile(file,JSON.stringify(plan));await writeFile(runFile,JSON.stringify(run));
  await mkdir(join(dir,'knowledge'));const nodes=catalog.entries.map((entry:any)=>({path:'/commands/'+entry.words.join('/'),entries:[{kind:'definition',reference:entry.reference,data:{words:entry.words,signatures:entry.signatures}}]}));
  const nodesFile=join(dir,'knowledge','nodes.jsonl'),head={schema:'run-knowledge@1',run:runId,root:catalog.root,nodes:nodes.length};
  await writeFile(nodesFile,[head,...nodes].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const missing=await runCli(['--file',file,'--run',runFile]);assert.equal(missing.code,1,missing.stderr);const report=JSON.parse(missing.stdout);assert.equal(report.cleanup_checked,true);assert.ok(report.problems.some((p:any)=>p.code==='case-compile.method_forbidden'&&p.message.includes('demo switch off')));
  const cleaned=fixture(['demo switch on',cleanup('demo switch off')]);plan.slots.plan[0].data=withExpect(cleaned.subject.data);await writeFile(file,JSON.stringify(plan));const good=await runCli(['--file',file,'--run',runFile]);assert.equal(good.code,0,good.stderr);assert.equal(JSON.parse(good.stdout).cleanup_checked,true);
  await writeFile(nodesFile,[{...head,root:'f'.repeat(64)},...nodes].map(row=>JSON.stringify(row)).join('\n'));const wrongRoot=await runCli(['--file',file,'--run',runFile]);assert.equal(wrongRoot.code,1);assert.match(wrongRoot.stderr,/冻结运行/);
  await rm(nodesFile);const absent=await runCli(['--file',file,'--run',runFile]);assert.equal(absent.code,1);assert.equal(JSON.parse(absent.stdout).cleanup_checked,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
