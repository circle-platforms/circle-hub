import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as rules from './docs-rules.ts';
const sample=(minor:number,separator='.')=>['10',String(minor),'2'].join(separator);

test('protected release contexts report locations without echoing values',()=>{
 assert.equal(typeof rules.versionLineProblems,'function');
 for(let minor=0;minor<=5;minor++){
  for(const text of ['版本线 '+sample(minor),'version line '+sample(minor),'line: "'+sample(minor)+'"','MIN_LINE = \''+sample(minor)+'\'', 'const MIN_LINE: string | null = \''+sample(minor)+'\'', '\'059：'+sample(minor)+'\'','Rel_Synthetic_'+sample(minor,'_'),'Beta_Synthetic_'+sample(minor,'_')]){
   assert.deepEqual(rules.versionLineProblems('ops/sample.txt','header\n'+text),['ops/sample.txt:2: protected release line']);
  }
 }
});
test('budgets, durations, percentages, addresses and dependency versions are not release-line declarations',()=>{
 const text=['timeoutMs: 10_000','inputBytes: 10_000_000','elapsed 10.0 ms','completion 10.0%','"typescript": "5.10.0"','address 192.0.2.1','line: "10.6.1"','version line 10.50','package version 1.10.0'].join('\n');
 assert.deepEqual(rules.versionLineProblems('hub/sample.ts',text),[]);
});
test('only frozen archives, lock files and exact pinned vendor bytes can be excluded',()=>{
 const text='版本线 '+sample(4);
 for(const path of ['foundation/a.txt','references/a.txt','package-lock.json','docs/Gemfile.lock','pnpm-lock.yaml'])assert.deepEqual(rules.versionLineProblems(path,text),[]);
 assert.equal(rules.versionLineProblems('packs/product/other/vendor/core.mjs',text).length,1);
 const file='packs/product/famx/functions/adoc/vendor/core.mjs';const source=readFileSync(file,'utf8');const digest=createHash('sha256').update(source).digest('hex');
 assert.deepEqual(rules.versionLineProblems(file,source,digest),[]);
 assert.equal(rules.versionLineProblems(file,source+'\n'+text,digest).length,1);
});
test('tracked repository text has no protected release-line contexts',()=>{
 const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\0').filter(Boolean);
 const hits=files.flatMap(file=>{
  let digest='';const text=rules.trackedFileText(file,bytes=>digest=createHash('sha256').update(bytes).digest('hex'));
  return text===null?[]:rules.versionLineProblems(file,text,digest);
 });
 assert.deepEqual(hits,[]);
});
