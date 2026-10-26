import assert from 'node:assert/strict';
import { test } from 'node:test';
import TABLE from '../tables/template-v3.json' with {type:'json'};
import CHECKS from '../checks.json' with {type:'json'};
import { templateCoverage } from './template-coverage.ts';
const item={id:'d:c',fields:{document:'d',node:'n/c',title:'audit 审计日志',category_ids:['audit_log'],tags:['Functional']}};
function input(category_ids?:unknown){return{items:[item],template:TABLE,inputs:[{external:'agile:mindmap:d',parser:'kityminder@1',model:{nodes:[{selector:'n/c',data:category_ids===undefined?{}:{category_ids}}]}}]};}
function facts(value:unknown){const out=templateCoverage(value);assert.ok(!('error'in out));return out;}
test('the legacy export is not wired to any case-review check',()=>{assert.ok(CHECKS.checks.every(c=>!JSON.stringify(c).includes('template-coverage')));});
test('words, legacy tags and a caller-added projected field are not original author evidence',()=>{const out=facts(input());assert.deepEqual(out.covered,[]);assert.deepEqual(out.missing,[]);assert.deepEqual(out.unclassified,['d:c']);});
test('an original exact author field works independently of the title and duplicate ids count once',()=>{const out=facts(input(['audit_log','functional','audit_log']));assert.deepEqual(out.covered,['functional','audit_log']);assert.equal(out.categories.find(c=>c.id==='audit_log')?.count,1);assert.deepEqual(out.missing,['configuration','integration','compatibility','negative','stress']);});
test('closed category metadata preserves required policy outside rows and rejects matching fields',()=>{for(const c of TABLE.categories)assert.deepEqual(Object.keys(c).sort(),['description','group','id','label']);for(const key of ['contains','prefixes','equals','tags','fields'])assert.ok('error'in templateCoverage({...input(),template:{...TABLE,categories:[{...TABLE.categories[0],[key]:[]}]}}));});
test('noncanonical and malformed author values are structural errors',()=>{for(const value of [['Audit_log'],[' audit_log'],['审计日志'],['unknown'],[],[null],'audit_log'])assert.ok('error'in templateCoverage(input(value)));});
test('caller-provided judgments cannot masquerade as accepted validation results',()=>{assert.ok('error'in templateCoverage({...input(),judgments:[]}));});
test('invalid inputs and skips are refused rather than silently shrinking scope',()=>{for(const value of [null,{}, {items:[null],template:TABLE},{...input(),skipped:[{category:'unknown',reason:'声明'}]},{...input(),skipped:[{category:'audit_log',reason:' '}]}])assert.ok('error'in templateCoverage(value));});
