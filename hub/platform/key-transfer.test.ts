import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { exportVaultKey, importVaultKey, processKeyTransferIo, type KeyTransferIo } from './key-transfer.ts';
import type { KeychainStore } from './keychain.ts';
import { runPlatformCommand } from './cli.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { exit, ok, recordingRunner } from './test-support.ts';

function memoryStore(initial?: Uint8Array) {
  let stored = initial && Uint8Array.from(initial); let reads = 0, writes = 0;
  const store: KeychainStore = {
    service:'synthetic', account:'vault', init:async()=>{}, delete:async()=>false,
    status:async()=>({present: stored !== undefined}),
    read:async()=>{ reads++; if (!stored) throw new Error('synthetic private diagnostic'); return Uint8Array.from(stored); },
    write:async(value)=>{ writes++; if(stored)throw new Error('synthetic private diagnostic'); stored=Uint8Array.from(value); },
  };
  return {store, get:()=>stored, reads:()=>reads, writes:()=>writes};
}
function channel(overrides: Partial<KeyTransferIo> = {}): KeyTransferIo {
  return {inputIsPipe:()=>true, outputIsPipe:()=>true, read:async()=>new Uint8Array(32), write:async()=>{}, ...overrides};
}

test('export refuses non-pipe output before reading the key and never includes failures in diagnostics', async()=>{
 const source=memoryStore(new Uint8Array(32).fill(13));
 await assert.rejects(exportVaultKey(source.store,channel({outputIsPipe:()=>false})),/管道或套接字/);
 assert.equal(source.reads(),0);
 await assert.rejects(exportVaultKey(source.store,channel({write:async()=>{throw new Error('synthetic private diagnostic');}})),error=>error instanceof Error && /密钥导出未完成/.test(error.message) && !error.message.includes('synthetic private diagnostic'));
});

test('import refuses non-pipe input and refuses an existing key before consuming input', async()=>{
 const target=memoryStore(new Uint8Array(32).fill(7)); let read=false;
 await assert.rejects(importVaultKey(target.store,channel({inputIsPipe:()=>false})),/管道或套接字/);
 await assert.rejects(importVaultKey(target.store,channel({read:async()=>{read=true;return new Uint8Array(32);}})),/已存在，不覆盖/);
 assert.equal(read,false); assert.equal(target.writes(),0); assert.deepEqual(target.get(),new Uint8Array(32).fill(7));
});

test('transfer copies exactly 32 bytes, wipes transport buffers, and cannot replace an existing key', async()=>{
 const original=new Uint8Array(32).map((_,i)=>i); const source=memoryStore(original); const target=memoryStore(); let inTransit:Uint8Array|undefined;
 await exportVaultKey(source.store,channel({write:async(value)=>{inTransit=Uint8Array.from(value);}}));
 assert.ok(inTransit); const received=inTransit;
 await importVaultKey(target.store,channel({read:async()=>received}));
 assert.deepEqual(target.get(),original); assert.ok(received.every(byte=>byte===0));
 await assert.rejects(importVaultKey(target.store,channel()),/已存在，不覆盖/);
});

test('invalid input lengths and key-store race are refused without echoing values', async()=>{
 for(const length of [0,31,33]) {
  const target=memoryStore();const input=new Uint8Array(length).fill(23);
  await assert.rejects(importVaultKey(target.store,channel({read:async()=>input})),/密钥导入未完成/);
  assert.equal(target.writes(),0); assert.ok(input.every(x=>x===0));
 }
 const target=memoryStore(); target.store.write=async()=>{throw new Error('synthetic private diagnostic');};
 await assert.rejects(importVaultKey(target.store,channel()),error=>error instanceof Error && !error.message.includes('synthetic private diagnostic'));
});

test('stream reader enforces exact length without text conversion', async()=>{
 for(const size of [31,32,33]){
  const input=new PassThrough(),output=new PassThrough();const io=processKeyTransferIo(input,output);
  const pending=io.read();input.end(Buffer.alloc(size,9));
  if(size===32){const bytes=await pending;assert.equal(bytes.length,32);assert.ok(bytes.every(x=>x===9));bytes.fill(0);}
  else await assert.rejects(pending);
 }
});

test('broken output reports a fixed failure and handles the later stream error',async()=>{
 const output=new Writable({write(_chunk,_encoding,callback){callback(new Error('synthetic private diagnostic'));}});
 const io=processKeyTransferIo(new PassThrough(),output);
 await assert.rejects(io.write(new Uint8Array(32)),error=>error instanceof Error && error.message==='output failed');
 await new Promise(resolve=>setImmediate(resolve));
});

test('a real stdout redirected to a regular file is refused before writing key bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-key-pipe-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'empty');const fd=openSync(target,'wx',0o600);
 const moduleUrl=new URL('./key-transfer.ts',import.meta.url).href;
 const code=`import {processKeyTransferIo} from ${JSON.stringify(moduleUrl)};const io=processKeyTransferIo();if(!io.outputIsPipe())process.exit(7);await io.write(new Uint8Array(32).fill(11));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore',fd,'ignore']});
 const result=await new Promise<number|null>(resolve=>child.on('exit',resolve));closeSync(fd);
 assert.equal(result,7);assert.equal((await stat(target)).size,0);
});

test('real inherited pipe transfers binary key bytes without writing a file or command argument',async()=>{
 const moduleUrl=new URL('./key-transfer.ts',import.meta.url).href;
 const producer=`import {processKeyTransferIo} from ${JSON.stringify(moduleUrl)};const io=processKeyTransferIo();if(!io.outputIsPipe())process.exit(2);const value=Uint8Array.from({length:32},(_,i)=>i);await io.write(value);value.fill(0);`;
 const consumer=`import {processKeyTransferIo} from ${JSON.stringify(moduleUrl)};const io=processKeyTransferIo();if(!io.inputIsPipe())process.exit(2);const value=await io.read();const ok=value.length===32&&value.every((v,i)=>v===i);value.fill(0);process.exitCode=ok?0:3;`;
 const left=spawn(process.execPath,['--input-type=module','-e',producer],{stdio:['ignore','pipe','pipe']});
 const right=spawn(process.execPath,['--input-type=module','-e',consumer],{stdio:['pipe','ignore','pipe']});
 left.stdout.pipe(right.stdin);let errors='';left.stderr.on('data',chunk=>errors+=chunk);right.stderr.on('data',chunk=>errors+=chunk);
 const [a,b]=await Promise.all([new Promise<number|null>(r=>left.on('exit',r)),new Promise<number|null>(r=>right.on('exit',r))]);
 assert.equal(a,0,errors);assert.equal(b,0,errors);assert.equal(errors,'');
});

test('platform key commands require confirmation and transfer only binary pipe data, never diagnostic output',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-key-transfer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const layout=layoutAt(root);await ensureLayout(layout);await writeSettingsFile(layout,newSettingsFile({environment:'test'}));
 const initial=Buffer.from(Uint8Array.from({length:32},(_,i)=>i));let value:string|undefined=initial.toString('hex');
 const runner=recordingRunner(call=>{
  if(call.command!=='/usr/bin/security')return undefined;
  if(call.args[0]==='find-generic-password')return value ? ok(call.args.includes('-w')?value+'\n':'present') : exit(44,'missing');
  if(call.args[0]==='-i'){if(value)return exit(45,'already present');value=/-w ([0-9a-f]{64})/.exec(call.options.input ?? '')?.[1];return ok();}
  return exit(1,'unexpected');
 },{real:false});
 const out:string[]=[],err:string[]=[];let transfer:Uint8Array|undefined;
 const io={stdout:(line:string)=>out.push(line),stderr:(line:string)=>err.push(line),env:{CIRCLE_HUB_DATA_DIR:root},cwd:root,keyTransfer:channel({write:async(bytes)=>{transfer=Uint8Array.from(bytes);},read:async()=>transfer!})};
 const run=(...args:string[])=>runPlatformCommand(args,io,{runner:runner.runner});
 assert.equal(await run('key','export'),2);assert.equal(runner.calls.length,0);
 out.length=0;err.length=0;
 assert.equal(await run('key','export','--confirm'),0);assert.ok(transfer);assert.deepEqual(Buffer.from(transfer),initial);assert.deepEqual(out,[]);assert.deepEqual(err,[]);
 value=undefined;assert.equal(await run('key','import'),0);assert.equal(value,initial.toString('hex'));
 assert.deepEqual(out,[]);assert.match(err.join('\n'),/已导入/);
 for(const call of runner.calls)assert.ok(!call.args.some(arg=>arg.includes(initial.toString('hex'))));
 assert.ok(![...out,...err].join('\n').includes(initial.toString('hex')));
});
