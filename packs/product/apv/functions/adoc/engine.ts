// The pinned engine decides attributes and conditional semantics. The adapter never renders HTML or invokes include I/O.
import { load, getVersion, MemoryLogger, LoggerManager, type EngineDocument } from './vendor/core.mjs';
import { ENGINE, fail } from './input.ts';

// One producer call already owns a fresh sandbox. Serialize host-side calls as well, so the public global logger API
// cannot mix two parses; no async_hooks import and no change to the pinned bundle or sandbox allowlist.
let pending = Promise.resolve();
export async function engineSession<T>(work: () => Promise<T>): Promise<T> {
  const before = pending;
  let release!: () => void;
  pending = new Promise<void>((resolve) => { release = resolve; });
  await before;
  const previous = LoggerManager.getLogger();
  LoggerManager.setLogger(new MemoryLogger());
  try { return await work(); }
  finally { LoggerManager.setLogger(previous); release(); }
}

export async function document(text: string, main: string, attributes: Record<string, unknown>, parse = true): Promise<{ doc: EngineDocument; logger: MemoryLogger }> {
  if (getVersion() !== ENGINE.version) fail('engine_version', '引擎版本与组成策略不符');
  const logger = LoggerManager.getLogger() as MemoryLogger;
  const doc = await load(text, { safe: 'secure', sourcemap: true, parse, attributes: { ...attributes, webfonts:false, reproducible: '', docfile: main } });
  return { doc, logger };
}
/** The current engine attribute state, including body assignments restored through the public playback API. */
export async function attributesAfter(text: string, main: string, attributes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const previous = LoggerManager.getLogger();
  LoggerManager.setLogger(new MemoryLogger());
  try {
    // A prefix can end inside a valid open block. Its temporary diagnostics do not describe the full book.
    // A trailing body assignment has no playback carrier yet; a fixed neutral paragraph flushes pending entries.
    const { doc } = await document(text + '\n\nhub_adoc_attribute_state_probe\n', main, attributes);
    for (const block of doc.findBy()) doc.playbackAttributes(block.attributes);
    return { ...doc.getAttributes() };
  } finally { LoggerManager.setLogger(previous); }
}
/** A tiny predicate probe, not a parse of discarded source content and not a second implementation of ifdef/ifndef. */
export async function conditionValue(directive: string, main: string, attributes: Record<string, unknown>): Promise<boolean> {
  const match = /^(ifdef|ifndef)::([^\[]+)\[/.exec(directive);
  if (!match) fail('conditional_syntax', '不支持的条件指令');
  const marker = 'hub_adoc_condition_selected';
  const source = `${match[1]}::${match[2]}[]\n\n${marker}\n\nendif::${match[2]}[]`;
  const { doc } = await document(source, main, attributes);
  return doc.findBy({ context: 'paragraph' }).some((block) => block.getSource?.() === marker);
}

interface DroppedCell {sourceLocation?:{lineno:number}}
interface TableContext {_columnVisits:number;_currentRow:DroppedCell[];logger:MemoryLogger;closeTable():void}
let tableContext:TableContext|null=null;
/** Observe the pinned engine's actual discarded cell objects; never classify an ERROR by its message words. */
export async function parseDocument(doc:EngineDocument,logger:MemoryLogger):Promise<{recoverable:Set<object>;drops:Array<{cells:number;line:number}>}>{
 if(tableContext===null){
  const saved=LoggerManager.getLogger();LoggerManager.setLogger(new MemoryLogger());
  try{const probe=await load('[cols="1"]\n|===\n|schema probe\n|===\n',{safe:'secure',sourcemap:true});
   const table=probe.findBy({context:'table'})[0] as unknown as {constructor:{ParserContext:{prototype:TableContext}}};
   tableContext=table.constructor.ParserContext.prototype;
  }finally{LoggerManager.setLogger(saved);}
 }
 const proto=tableContext,original=proto.closeTable,recoverable=new Set<object>(),drops:Array<{cells:number;line:number}>=[];
 proto.closeTable=function(){
  const own=this.logger===logger&&this._columnVisits>0&&this._currentRow.length>0;
  const cells=own?[...this._currentRow]:[],before=logger.messages.length;
  original.call(this);
  const emitted=logger.messages.slice(before);
  if(own&&emitted.length===1&&emitted[0].severity==='ERROR'&&cells.every(cell=>Number.isSafeInteger(cell.sourceLocation?.lineno??emitted[0].sourceLocation?.lineno))){
   recoverable.add(emitted[0]);const counts=new Map<number,number>();for(const cell of cells){const line=(cell.sourceLocation?.lineno??emitted[0].sourceLocation!.lineno);counts.set(line,(counts.get(line)??0)+1);}for(const [line,cells]of counts)drops.push({line,cells});
  }
 };
 try{await doc.parse();return {recoverable,drops};}finally{proto.closeTable=original;}
}

interface UntilOptions {
 terminator?:unknown;context?:unknown;cursor?:unknown;
 skipFirstLine?:boolean;skip_first_line?:boolean;
}
interface RecoveryReader {
 cursor:{lineno:number};cursorAtMark():{lineno:number};unterminated?:boolean|null;logger:unknown;
 readLine():Promise<string|undefined>;
 readLinesUntil(options?:UntilOptions,filter?:unknown):Promise<string[]>;
}
export interface UnterminatedRead {line:number;end:number;kind:string;delimiter:string}
/** Observe the pinned reader's own termination condition and consumed cursor. No message-word classification,
 * source repair or delimiter/section parser is introduced. The engine session serializes these temporary hooks. */
export function observeUnterminated(doc:EngineDocument,logger:MemoryLogger):{blocks:UnterminatedRead[];restore:()=>void}{
 const reader=doc.getReader() as unknown as RecoveryReader;
 const owner=(name:'readLine'|'readLinesUntil'):RecoveryReader=>{
  let proto=Object.getPrototypeOf(reader);
  while(proto&&!Object.hasOwn(proto,name))proto=Object.getPrototypeOf(proto);
  if(!proto||typeof proto[name]!=='function')fail('engine_parse','固定引擎缺少结构化定界读取接口');
  return proto as RecoveryReader;
 };
 const lineProto=owner('readLine'),untilProto=owner('readLinesUntil');
 const readLine=lineProto.readLine,readUntil=untilProto.readLinesUntil;
 const history=new WeakMap<RecoveryReader,{value:string;line:number}>();
 const frames=new WeakMap<RecoveryReader,Array<{last:unknown}>>();
 const blocks:UnterminatedRead[]=[];
 lineProto.readLine=async function(this:RecoveryReader){
  const value=await readLine.call(this);
  if(this.logger===logger){
   if(value!==undefined)history.set(this,{value,line:this.cursor.lineno-1});
   const frame=frames.get(this)?.at(-1);if(frame)frame.last=value;
  }
  return value;
 };
 untilProto.readLinesUntil=async function(this:RecoveryReader,options:UntilOptions={},filter?:unknown){
  const delimiter=options.terminator;
  const context=Object.hasOwn(options,'context')?options.context:delimiter;
  if(this.logger!==logger||typeof delimiter!=='string'||!delimiter||typeof context!=='string'||!context)return readUntil.call(this,options,filter);
  const previous=history.get(this);
  const supplied=options.cursor==='at_mark'?this.cursorAtMark():options.cursor as {lineno?:number}|undefined;
  const line=options.skipFirstLine||options.skip_first_line?this.cursor.lineno:previous?.value===delimiter?previous.line:supplied?.lineno??this.cursor.lineno;
  const stack=frames.get(this)??[],frame={last:undefined as unknown};stack.push(frame);frames.set(this,stack);
  try{
   const result=await readUntil.call(this,options,filter);
   if(this.unterminated===true&&frame.last!==delimiter)blocks.push({line,end:Math.max(line,this.cursor.lineno-1),kind:context,delimiter});
   return result;
  }finally{stack.pop();}
 };
 return {blocks,restore:()=>{lineProto.readLine=readLine;untilProto.readLinesUntil=readUntil;}};
}
