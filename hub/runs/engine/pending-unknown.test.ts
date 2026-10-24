import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECOVERY } from '../../../contracts/src/fixtures.ts';
import { partitionCountsOf } from '../../../contracts/src/validation.ts';
import { countsText } from '../../server/text.ts';
import { partitionItems, assertCovering } from './partitions.ts';
test('a violation with unresolved gaps remains in one partition and has a separate pending count',()=>{
  const parts=partitionItems([{item:'synthetic-a',label:'A',location:`src:${'a'.repeat(64)}`,required:new Set(['r']),notCovered:false,rejection:'demo.reject',requirements:[{requirement:'r',status:'unsatisfied',unsatisfied_reason:'outcome_mismatch',claims:[],layers:[{layer:'static',terminal:'violation',code:'demo.reject',gaps:[{reason:'missing_input',...RECOVERY}]}]}]}],['synthetic-a']);
  assertCovering(parts,['synthetic-a']);
  assert.equal(parts.rejected.length,1);
  assert.equal(parts.delivered.length+parts.incomplete.length+parts.quarantined.length,0);
  const counts=partitionCountsOf(parts);
  assert.equal(counts.unknown,0);
  assert.equal(counts.pending_unknown,1);
  assert.ok(countsText(counts).includes('其中 1 个还有未决未知'));
});
