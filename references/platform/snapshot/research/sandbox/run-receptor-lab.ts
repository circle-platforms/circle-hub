import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const root = process.env.INFOSEC_LAB_ROOT!;
if (!root) throw new Error('Set INFOSEC_LAB_ROOT');
const here = path.dirname(new URL(import.meta.url).pathname);
const execute = promisify(execFile); const owned: any[] = []; const observations: any[] = [];
const sockdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispr-'));
const binary = path.join(root, 'runtime/receptor');
const cli = path.join(root, 'runtime/upstream-python/bin/receptorctl');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function port() { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return p; }
async function start(id: string, p?: number, peer?: number, work = false) {
 const args = ['--node', `id=${id}`, `datadir=${root}/private/receptor-${id}`, '--log-level', 'level=debug', '--control-service', `filename=${sockdir}/${id}.sock`];
 if (p) args.push('--tcp-listener', 'bindaddr=127.0.0.1', `port=${p}`);
 if (peer) args.push('--tcp-peer', `address=127.0.0.1:${peer}`, 'redial=true');
 if (work) args.push('--work-command', 'worktype=synthetic', `command=${process.execPath}`, `params=${here}/receptor-work.ts`);
 const log = fs.openSync(`${root}/evidence/receptor-${id}.log`, 'a');
 const child = spawn(binary, args, { env: { PATH: process.env.PATH!, INFOSEC_LAB_ROOT: root }, stdio: ['ignore', log, log] }); fs.closeSync(log); owned.push(child);
 for(let i=0;i<50;i++){ if(fs.existsSync(`${sockdir}/${id}.sock`)) return child; if(child.exitCode !== null) throw new Error(`${id} exited: ${child.exitCode}`); await delay(100); } throw new Error(`${id} startup timeout`);
}
async function ctl(id: string, args: string[], timeout = 6000) { const result = await execute(cli, ['--socket', `${sockdir}/${id}.sock`, ...args], { timeout, maxBuffer: 1024 * 1024 }); return result.stdout; }
async function stop(child: any) { if(child.exitCode !== null) return; child.kill('SIGTERM'); for(let i=0;i<30&&alive(child.pid);i++) await delay(100); if(alive(child.pid)) child.kill('SIGKILL'); await delay(100); }
const startedAt = new Date().toISOString();
fs.rmSync(`${root}/evidence/receptor-remote-effect.json`,{force:true});
for(const id of ['controller','relay','executor']){fs.rmSync(`${root}/private/receptor-${id}`,{recursive:true,force:true});fs.writeFileSync(`${root}/evidence/receptor-${id}.log`,'');}
try {
 const aPort = await port(); const bPort = await port();
 await start('controller', aPort); let relay = await start('relay', bPort, aPort); await start('executor', undefined, bPort, true);
 let ping=''; for(let i=0;i<40;i++){ try { ping = await ctl('controller',['ping','executor','--count','1'],2500); break; } catch { await delay(500); } } assert.ok(ping.includes('executor') || ping.includes('Reply'));
 const trace = await ctl('controller',['traceroute','executor']); observations.push({ name:'three-node-routing', ping, trace });
 const submission = await ctl('controller',['work','submit','synthetic','--node','executor','--no-payload']); const unit = /Unit ID:\s*(\S+)/.exec(submission)?.[1]; assert.ok(unit, submission);
 await delay(1800); const localBefore = await ctl('controller',['work','list','--unit_id',unit!]); const remoteBefore = await ctl('executor',['work','list']);
 await stop(relay); await delay(7500);
 assert.ok(fs.existsSync(`${root}/evidence/receptor-remote-effect.json`));
 const duringFailure = await ctl('controller',['work','list','--unit_id',unit!]);
 observations.push({ name:'relay-loss-remote-effect', localUnit:unit, localBefore, remoteBefore, duringFailure, remoteEffect:JSON.parse(fs.readFileSync(`${root}/evidence/receptor-remote-effect.json`,'utf8')) });
 fs.rmSync(`${sockdir}/relay.sock`, {force:true}); relay=await start('relay',bPort,aPort);
 let final=''; for(let i=0;i<40;i++){ final=await ctl('controller',['work','list','--unit_id',unit!]); if(final.includes('Succeeded')) break; await delay(500); }
 assert.equal(JSON.parse(final)[unit!].StateName,'Succeeded');
 const output = await ctl('controller',['work','results',unit!],10000); assert.ok(output.includes('remote-effect-written'));
 assert.equal(JSON.parse(output.split('\n')[0]).pid,JSON.parse(fs.readFileSync(`${root}/evidence/receptor-remote-effect.json`,'utf8')).pid);
 fs.writeFileSync(`${root}/evidence/receptor-output.bin`,output); observations.push({name:'relay-return-results-recovered', final, outputSha256:hash(Buffer.from(output))});
} finally {
 for(const child of owned.reverse()) await stop(child);
 const cleanup=owned.map(child=>({pid:child.pid,exited:!alive(child.pid),exitCode:child.exitCode}));
 fs.writeFileSync(`${root}/evidence/receptor-lab-receipt.json`,JSON.stringify({startedAt,endedAt:new Date().toISOString(),sourceSha256:hash(fs.readFileSync(new URL(import.meta.url))),binarySha256:hash(fs.readFileSync(binary)),observations,cleanup,scope:'Loopback three-node mesh; no TLS or production equipment'},null,2));
 fs.rmSync(sockdir,{recursive:true,force:true}); console.log(JSON.stringify({observations:observations.length,ownedProcessesStopped:cleanup.every(c=>c.exited)}));
}
