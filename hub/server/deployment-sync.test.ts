import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncReport } from '../knowledge/api.ts';
import { unchangedDeploymentProbe } from './deployment-sync.ts';

function probe(): SyncReport {
  return { sync:'synthetic',product:'synthetic',pack:'synthetic@1.0.0',dry_run:true,started_at:'2026-11-13T00:00:00.000Z',ended_at:'2026-11-13T00:00:01.000Z',
    plan:{rounds:1,done:true,note:null,builds:1,reads:1,failed_reads:[],limits:{rounds:false,reads:false,max_rounds:6,max_reads:300}},
    builds:[{name:'synthetic-build',family:'synthetic',line:'synthetic-line',base:'synthetic-build',outcome:'skipped',reason:'synthetic',root:'a'.repeat(64),composition:'b'.repeat(64)}],
    pointers:[],counts:{produced:0,registered:0,skipped:1,failed:0},warnings:[],error:null };
}
test('only a complete fresh probe with every existing root unchanged skips actual synchronization', () => {
  assert.equal(unchangedDeploymentProbe(probe()),true);
  const changed=probe();changed.builds[0].would_produce=true;assert.equal(unchangedDeploymentProbe(changed),false);
  const missing=probe();missing.builds[0].root=null;assert.equal(unchangedDeploymentProbe(missing),false);
  const scope=probe();scope.scope={outcome:'skipped',reason:'synthetic',root:null,composition:null,would_produce:true};assert.equal(unchangedDeploymentProbe(scope),false);
});
test('unknown, partial, failed, or non-probe results never claim current', () => {
  const reports: SyncReport[]=[];
  let report=probe();report.dry_run=false;reports.push(report);
  report=probe();report.plan.done=false;reports.push(report);
  report=probe();report.plan.limits.reads=true;reports.push(report);
  report=probe();report.plan.failed_reads.push({id:'synthetic-source',reason:'unavailable'});reports.push(report);
  report=probe();report.counts.failed=1;reports.push(report);
  report=probe();report.error='synthetic failure';reports.push(report);
  report=probe();report.builds=[];reports.push(report);
  report=probe();report.builds[0].outcome='registered';reports.push(report);
  report=probe();report.builds[0].composition=null;reports.push(report);
  for (const result of reports) assert.equal(unchangedDeploymentProbe(result),false);
});
