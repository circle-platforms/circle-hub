import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompileBrief } from '../functions/authoring-brief.ts';
import { renderTaskBrief, resolveSubagentRole } from '../functions/subagent-roles.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const prerequisites = Array.from({ length: 5 }, (_, i) => `合成前置 ${i + 1}：两端各自完成准备 ${i + 1}`);
function makeBrief(extra: string[] = []) {
  const record = {
    schema: 'recompose-record@1', case: { id: 'synthetic-case', title: '合成前置传递' },
    atoms: [{ id: 'a1', kind: 'action', text: 'synthetic action', quote_ref: `src:${'c'.repeat(64)}/n/1` }],
    expectation_slots: [], ledgers: { adapted: [], original: [], concretizations: [] },
    unknowns: [], sources: { governing: [], candidates: [], states: [{
      atom: 'a1', state: 'missing_prerequisite', reason: '合成手册明确声明的准备', prerequisites: [...prerequisites, ...extra],
    }] },
    adjudication: { states: [{ atom: 'decoy', state: 'missing_prerequisite', prerequisites: ['错误位置的诱饵'] }] },
  };
  const brief = buildCompileBrief({
    item: { id: 'synthetic:item', fields: { autoid: '990000000000000401', title: '合成前置传递', expected_nodes: [], recomposition: { receipt: `rec:${'b'.repeat(64)}`, record } } },
    index: '00', knowledge: { root: 'a'.repeat(64), nodes: new Map(), lines: new Map(), parameters: new Map() },
    policy: null, round: 1, mode: 'initial', createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(brief);
  return brief;
}
function task(brief: ReturnType<typeof makeBrief>) {
  return renderTaskBrief({ role: resolveSubagentRole('plan')!, caseRef: brief.identity.autoid,
    briefPath: 'briefs/00.md', outPath: 'plans/00.json', skillDir: 'skills/case-compile',
    scopeText: '只处理本条合成用例', round: 1, compileBrief: brief });
}

test('T1b #36 reads the authored sources.states path and never substitutes adjudication.states', () => {
  const brief = makeBrief();
  assert.deepEqual(brief.materials.prerequisites.from_recompose_states[0].prerequisites, prerequisites);
  assert.equal(brief.materials.prerequisites.from_recompose_states[0].origin, 'record.sources.states');
  assert.ok(!JSON.stringify(brief.materials.prerequisites).includes('错误位置的诱饵'));
});
test('T1b #36 named writer task contains every prerequisite and truthful partial disclosure', () => {
  const brief = makeBrief(), output = task(brief);
  for (const prerequisite of prerequisites) assert.ok(output.includes(prerequisite), prerequisite);
  assert.equal(brief.materials.prerequisites.status, 'partial_recompose_only');
  assert.ok(!brief.materials.prerequisites.scan_reason.includes('均未声明'));
  assert.ok(output.includes('record.sources.states'));
});
test('T1b #36 complete prerequisite bytes survive the task history budget', () => {
  const last = '最后一条合成前置必须保留';
  const output = task(makeBrief([...Array.from({ length: 30 }, (_, i) => `前置${i}：${'合成事实'.repeat(300)}`), last]));
  assert.ok(output.includes(last));
  assert.ok(output.includes('本轮测试范围'));
  assert.ok(output.includes("--file 'plans/00.json'"));
});
test('T1b #36 an older explanatory sentence cannot override the extracted prerequisite list', () => {
  const brief = makeBrief();
  brief.materials.prerequisites.scan_reason = '重组记录与产品目录均未声明前置';
  const output = task(brief);
  for (const prerequisite of prerequisites) assert.ok(output.includes(prerequisite));
  assert.ok(!output.includes('均未声明'));
});
test('T1b #36 task-brief CLI writes all frozen prerequisites and the current card decision for the writer', async () => {
  const root=await mkdtemp(join(tmpdir(),'task-materials-proof-'));
  try {
    for(const dir of ['run/items','run/briefs','run/knowledge']) await mkdir(join(root,dir),{recursive:true});
    const identity='990000000000000401';
    await writeFile(join(root,'scope.md'),`## 用例 ${identity}\n使用者决定：执行合成前置\n## 用例 other-case\n使用者决定：不属于本条\n`);
    await writeFile(join(root,'run/run.json'),JSON.stringify({run:'run_synthetic',product:'synthetic',version:'1',build:'synthetic',groups:[]}));
    await writeFile(join(root,'run/briefs/00.md'),'# 合成静态简报\n');
    await writeFile(join(root,'run/items/00.json'),JSON.stringify({id:'synthetic:item',fields:{autoid:identity,title:'合成前置传递',recomposition:{receipt:`rec:${'b'.repeat(64)}`,record:{case:{id:'synthetic-case',title:'合成前置传递'},atoms:[{id:'a1',kind:'action',text:'synthetic action'}],sources:{states:[{atom:'a1',state:'missing_prerequisite',reason:'合成声明',prerequisites}]},expectation_slots:[],unknowns:[]}}}}));
    await writeFile(join(root,'run/knowledge/nodes.jsonl'),JSON.stringify({schema:'run-knowledge@1',root:'a'.repeat(64),composition:null,nodes:0,entries:0})+'\n');
    for(const file of ['commands.txt','manual.txt']) await writeFile(join(root,'run/knowledge',file),'');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./task-brief.ts',import.meta.url)), '--role','脚本编写','--case',identity,'--brief','run/briefs/00.md','--out','plans/00.json','--task-file','tasks/00.md','--run','run'],{cwd:root,input:'',encoding:'utf8',env:{NODE_NO_WARNINGS:'1'},timeout:30_000});
    assert.equal(result.status,0,result.stderr);
    const output=await readFile(join(root,'tasks/00.md'),'utf8');
    for(const prerequisite of prerequisites) assert.ok(output.includes(prerequisite),prerequisite);
    assert.ok(output.includes('使用者决定：执行合成前置'));
    assert.ok(!output.includes('不属于本条'));
    assert.ok(!result.stdout.includes(prerequisites[0]));
  }finally{await rm(root,{recursive:true,force:true});}
});
