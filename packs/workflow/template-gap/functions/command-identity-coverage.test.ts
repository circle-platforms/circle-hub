import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandSampleSubjects} from '../testing/command-samples.ts';
import {commandOutcomes} from './command-check.ts';
test('a legacy path-only root is missing complete identities and cannot claim full command coverage',()=>{
 const subject=structuredClone(commandSampleSubjects()[0].subject);
 for(const entry of Object.values(subject.index.entries) as any[])delete entry.data.command_identities;
 const out=commandOutcomes(subject);assert.ok(out.some(o=>o.verdict==='unknown'&&JSON.stringify(o.data).includes('command_identities')));assert.ok(!out.some(o=>o.verdict==='refute'&&o.code==='template-gap.no_commands'));
});
test('unclassified cases cannot turn unseen command categories into definite shortfalls',()=>{
 const subject=structuredClone(commandSampleSubjects()[0].subject);for(const c of subject.cases as any[]){c.status='unclassified';c.categories=[];}
 const out=commandOutcomes(subject);assert.ok(out.some(o=>o.verdict==='unknown'));assert.ok(!out.some(o=>o.code==='template-gap.command_shortfall'));
});
