import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('review 17: tagged rescoring does not invent marked-only cases', t => {
  const out = mkdtempSync(join(tmpdir(), 'score-rule-')); t.after(() => rmSync(out, { recursive: true, force: true }));
  const source = { root: { data: { id: 'r', text: 'synthetic' }, children: [{ data: { id: 'marked', text: 'marked', priority: 2 }, children: [{ data: { id: 'e', text: 'expected' }, children: [] }] }, { data: { id: 'tagged', text: 'tagged', priority: 2, resource: ['configuration'] }, children: [{ data: { id: 'f', text: 'expected' }, children: [] }] }] } };
  writeFileSync(join(out, 'copy.json'), JSON.stringify(source)); writeFileSync(join(out, 'gold.json'), '[]');
  writeFileSync(join(out, 'run.json'), JSON.stringify({ latest: { result: { partitions: { delivered: [{ item: 'doc:tagged', requirements: [] }] } } } }));
  const run = spawnSync(process.execPath, ['scripts/real/score-injection.ts', '--gold', join(out, 'gold.json'), '--run', join(out, 'run.json'), '--copy', join(out, 'copy.json'), '--case-rule', 'tagged'], { encoding: 'utf8' });
  assert.equal(run.status, 0); assert.ok(run.stdout.includes('漏标 0'), run.stdout);
});

test('closure missing kind says to reinject and names its current private diagnostic', t => {
 const out=mkdtempSync(join(tmpdir(),'score-refusal-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
 writeFileSync(join(out,'gold.json'),JSON.stringify([{node:'private-node'}]));
 writeFileSync(join(out,'run.json'),JSON.stringify({latest:{result:{partitions:{delivered:[]}}}}));
 const run=spawnSync(process.execPath,['scripts/real/score-injection.ts','--gold',join(out,'gold.json'),'--run',join(out,'run.json')],{encoding:'utf8'});
 assert.equal(run.status,1);assert.match(run.stderr,/标准答案第 1 条没有 kind.*重新注入/);assert.ok(!run.stderr.includes('private-node'));
 const files=readdirSync(out).filter(name=>name.startsWith('refusal-'));assert.equal(files.length,1);assert.ok(run.stderr.includes(files[0]));
});
