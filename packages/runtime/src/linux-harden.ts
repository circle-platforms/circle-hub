import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {access, chmod, readFile, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// sock_filter is 8 bytes, little-endian: code u16, jt u8, jf u8, k u32.
const LD_W_ABS = 0x20;
const JMP_JEQ_K = 0x15;
const ALU_AND_K = 0x54;
const RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_STREAM = 1;

const auditArch: Record<string, number> = {x64: 0xc000003e, arm64: 0xc00000b7};
const socketSyscall: Record<string, number> = {x64: 41, arm64: 198};
// Dangerous syscalls the seatbelt profile also keeps away from an untrusted process.
const deniedSyscalls: Record<string, number[]> = {
  x64: [101, 165, 166, 155, 169, 246, 320, 175, 313, 176, 167, 168, 298, 321, 323, 304, 310, 311, 312],
  arm64: [117, 40, 39, 41, 142, 104, 294, 105, 273, 106, 224, 225, 241, 280, 282, 265, 270, 271, 272],
};

type Op =
  | {op: 'ld'; off: number}
  | {op: 'and'; k: number}
  | {op: 'ret'; k: number}
  | {op: 'jeq'; k: number; jt: string; jf: string}
  | {op: 'label'; name: string};

function assemble(ops: Op[]): Buffer {
  const at = new Map<string, number>();
  let count = 0;
  for (const op of ops) {
    if (op.op === 'label') at.set(op.name, count);
    else count += 1;
  }
  const buffer = Buffer.alloc(count * 8);
  let pc = 0;
  for (const op of ops) {
    if (op.op === 'label') continue;
    const offset = pc * 8;
    if (op.op === 'ld') buffer.writeUInt16LE(LD_W_ABS, offset), buffer.writeUInt32LE(op.off, offset + 4);
    else if (op.op === 'and') buffer.writeUInt16LE(ALU_AND_K, offset), buffer.writeUInt32LE(op.k >>> 0, offset + 4);
    else if (op.op === 'ret') buffer.writeUInt16LE(RET_K, offset), buffer.writeUInt32LE(op.k >>> 0, offset + 4);
    else {
      const jt = (at.get(op.jt) ?? -1) - (pc + 1);
      const jf = (at.get(op.jf) ?? -1) - (pc + 1);
      if (jt < 0 || jf < 0 || jt > 255 || jf > 255) throw new Error('Seccomp filter jump is out of range');
      buffer.writeUInt16LE(JMP_JEQ_K, offset);
      buffer.writeUInt8(jt, offset + 2);
      buffer.writeUInt8(jf, offset + 3);
      buffer.writeUInt32LE(op.k >>> 0, offset + 4);
    }
    pc += 1;
  }
  return buffer;
}

// Non-socket syscalls jump straight to ALLOW. A short jump that falls into the
// domain check treats ioctl and other calls as socket arguments and breaks Node.
export function seccompProgram(allowInet: boolean): Buffer | null {
  const arch = process.arch;
  const audit = auditArch[arch];
  const socket = socketSyscall[arch];
  const denied = deniedSyscalls[arch];
  if (audit === undefined || socket === undefined || !denied) return null;
  const ops: Op[] = [
    {op: 'ld', off: 4},
    {op: 'jeq', k: audit, jt: 'arch-ok', jf: 'kill'},
    {op: 'label', name: 'arch-ok'},
    {op: 'ld', off: 0},
  ];
  denied.forEach((number, index) => {
    const next = index === denied.length - 1 ? 'after-denied' : `deny-${index}`;
    ops.push({op: 'jeq', k: number, jt: 'errno', jf: next});
    if (index !== denied.length - 1) ops.push({op: 'label', name: next});
  });
  ops.push(
    {op: 'label', name: 'after-denied'},
    {op: 'jeq', k: socket, jt: 'socket', jf: 'allow'},
    {op: 'label', name: 'allow'},
    {op: 'ret', k: SECCOMP_RET_ALLOW},
    {op: 'label', name: 'errno'},
    {op: 'ret', k: SECCOMP_RET_ERRNO_EPERM},
    {op: 'label', name: 'kill'},
    {op: 'ret', k: SECCOMP_RET_KILL_PROCESS},
    {op: 'label', name: 'socket'},
    {op: 'ld', off: 16},
    {op: 'jeq', k: AF_UNIX, jt: 'socket-allow', jf: allowInet ? 'check-inet' : 'socket-deny'},
  );
  if (allowInet) {
    ops.push(
      {op: 'label', name: 'check-inet'},
      {op: 'jeq', k: AF_INET, jt: 'check-stream', jf: 'check-inet6'},
      {op: 'label', name: 'check-inet6'},
      {op: 'jeq', k: AF_INET6, jt: 'check-stream', jf: 'socket-deny'},
      {op: 'label', name: 'check-stream'},
      {op: 'ld', off: 24},
      {op: 'and', k: 0xff},
      {op: 'jeq', k: SOCK_STREAM, jt: 'socket-allow', jf: 'socket-deny'},
    );
  }
  ops.push(
    {op: 'label', name: 'socket-allow'},
    {op: 'ret', k: SECCOMP_RET_ALLOW},
    {op: 'label', name: 'socket-deny'},
    {op: 'ret', k: SECCOMP_RET_ERRNO_EPERM},
  );
  return assemble(ops);
}

export interface LandlockHelper {binary: string | null; abi: number}

const helperSource = fileURLToPath(new URL('../linux-landlock-helper.c', import.meta.url));
let helperCache: Promise<LandlockHelper> | undefined;

function run(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio: 'ignore'});
    const timer = setTimeout(() => {child.kill('SIGKILL'); resolve(false);}, timeoutMs);
    child.once('error', () => {clearTimeout(timer); resolve(false);});
    child.once('exit', code => {clearTimeout(timer); resolve(code === 0);});
  });
}

function capture(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'ignore']});
    let output = '';
    child.stdout.on('data', chunk => {output += chunk;});
    const timer = setTimeout(() => {child.kill('SIGKILL'); resolve(null);}, timeoutMs);
    child.once('error', () => {clearTimeout(timer); resolve(null);});
    child.once('exit', code => {clearTimeout(timer); resolve(code === 0 ? output.trim() : null);});
  });
}

async function commandOnPath(names: string[]): Promise<string | null> {
  const directories = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const name of names) for (const directory of directories) {
    const candidate = join(directory, name);
    try {await access(candidate); return candidate;} catch {/* try the next compiler */}
  }
  return null;
}

async function compileHelper(): Promise<LandlockHelper> {
  const source = await readFile(helperSource);
  const dest = join(tmpdir(), `circle-hub-landlock-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`);
  let ready = false;
  try {await access(dest); ready = true;} catch {/* compile once per source digest */}
  if (!ready) {
    const compiler = await commandOnPath(['cc', 'gcc']);
    if (!compiler) return {binary: null, abi: 0};
    const temporary = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}`;
    const compiled = await run(compiler, ['-O2', '-o', temporary, helperSource], 20_000);
    if (!compiled) {await rm(temporary, {force: true}); return {binary: null, abi: 0};}
    await chmod(temporary, 0o755);
    try {await rename(temporary, dest);} catch {await rm(temporary, {force: true});}
  }
  try {await access(dest);} catch {return {binary: null, abi: 0};}
  const reported = await capture(dest, ['--abi'], 3_000);
  const abi = reported && /^[0-9]+$/.test(reported) ? Number(reported) : 0;
  if (abi < 1) return {binary: null, abi: 0};
  return {binary: dest, abi};
}

export function landlockHelper(): Promise<LandlockHelper> {
  helperCache ??= compileHelper();
  return helperCache;
}
