// Product entry point over the model-generated shared exact grammar.
import type {CommandsResult} from './types.ts';
import {guarded,isRecord} from './util.ts';
import {compileGrammar,commandLines,parseCommand,type CommandDefinition} from './generated/command-grammar.ts';
export * from './generated/command-grammar.ts';

/** Explicit complete-line slots plus typed definitions; a head-only list is insufficient evidence. */
export function extractCommands(input:{text:string;heads?:string[];definitions?:CommandDefinition[]}):CommandsResult {
  if(!isRecord(input)||typeof input.text!=='string')return {phrases:[],warnings:['text 不是字符串']};
  if(!Array.isArray(input.definitions))return {phrases:[],warnings:['缺锁定命令树的完整类型语法；下一步：包作者绑定 words/signatures 后重跑']};
  if(input.text.length>1_000_000||input.definitions.length>100_000)return {phrases:[],warnings:['输入超过完整解析上限；下一步：包作者分片后重跑，不截断当作完整']};
  const grammar=compileGrammar(input.definitions);
  return {phrases:commandLines(input.text).filter(line=>parseCommand(grammar,line.text)!==null),warnings:[]};
}
export default function commands(input:unknown):CommandsResult {
  return guarded(()=>extractCommands(input as Parameters<typeof extractCommands>[0]),warning=>({phrases:[],warnings:[warning]}));
}
