import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NAMES } from '../../contracts/src/tools.ts';
import { installCommandSteps, commandStep, STEP_NAMES } from './trace-names.ts';

test('only installed command metadata determines a CLI step', t=>{
  t.after(()=>installCommandSteps([]));
  installCommandSteps([{name:'synthetic-command',step:'run-explicit-step'}]);
  assert.equal(commandStep('synthetic-command'),'run-explicit-step');
  assert.equal(commandStep('client-value'),'run-command');
  assert.equal(commandStep('run-explicit-step'),'run-command');
});

test('catalog replacement removes retired steps while retaining fixed trace names', t=>{
  t.after(()=>installCommandSteps([]));
  const names=STEP_NAMES;
  installCommandSteps([{name:'old',step:'run-old'},{name:'alias',step:'run-old'}]);
  assert.equal(names.filter(name=>name==='run-old').length,1);
  installCommandSteps([{name:'replacement',step:'run-replacement'}]);
  assert.equal(commandStep('old'),'run-command');assert.equal(names.includes('run-old'),false);
  assert.equal(commandStep('replacement'),'run-replacement');
  assert.equal(names,STEP_NAMES);
  for(const tool of TOOL_NAMES)assert.equal(names.includes(tool),true);
});
