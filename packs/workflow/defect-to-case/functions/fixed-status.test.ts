import assert from 'node:assert/strict';
import {test} from 'node:test';
import fixedStatus,{fixedStatusDeclaration} from './fixed-status.ts';
for(const value of [undefined,'closed','Fixed',null])test('undeclared fixed status '+String(value)+' is unknown with a recovery',()=>{const state=fixedStatusDeclaration({fields:{status:value,fix:'已修复 fixed'}});assert.equal(state.declaration_status,'undeclared');const out=fixedStatus({subject:{item:'synthetic',fields:{fixed_status:state}}})[0];assert.equal(out.verdict,'unknown');assert.ok(out.missing);assert.match(out.statement,/下一步/);});
test('only original fixed supports repaired status; known refutes that claim',()=>{for(const value of ['fixed','known']){const state=fixedStatusDeclaration({fields:{status:value}});assert.equal(state.declaration_status,'declared');assert.equal(fixedStatus({subject:{fields:{fixed_status:state}}})[0].verdict,value==='fixed'?'support':'refute');}});
test('author slots cannot supply a missing frozen release status',()=>{assert.equal(fixedStatus({subject:{fields:{},slots:{fixed_status:{status:'fixed'}}}})[0].verdict,'unknown');});
