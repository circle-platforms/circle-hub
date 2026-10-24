import assert from 'node:assert/strict';
import { LayerResult } from '../../../../contracts/src/validation.ts';
/** Preserve the old terminal assertions while also checking the complete new write shape. Exit policy has dedicated tests. */
export function assertLayers(actual:LayerResult[]|LayerResult,expected:unknown,message?:string):void{
  const layers=Array.isArray(actual)?actual:[actual];
  for(const layer of layers)LayerResult.parse(layer);
  const core=layers.map(({missing:_missing,exit:_exit,gaps:_gaps,...layer})=>layer);
  assert.deepEqual(Array.isArray(actual)?core:core[0],expected,message);
}
