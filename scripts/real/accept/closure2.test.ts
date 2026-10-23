import { test } from 'node:test';
import assert from 'node:assert/strict';
import scope from './regression-scope.ts';
import sweep from './maintenance-sweep.ts';
test('closure 02 live scenarios refuse pre-existing run disclosure exports',()=>{const common={product:'synthetic',earlier:'synthetic-10.6.0',later:'synthetic-10.6.1',caseCommandsUnplaced:0,unplaced:0};for(const [scenario,pack,extra]of [[scope,'regression-scope',{changed:[],removed:[],inScope:[],outOfScope:[]}],[sweep,'maintenance-sweep',{cases:[]}]] as const){const gold={...common,...extra,unplacedRun:{run:{run:'run_00000000000000000000000000',groups:[{kind:pack,message:'有 0 个用例没有解析出命令'}]}}};assert.throws(()=>scenario(gold as never),(error:any)=>error.reason==='live_replay');}});
