// Safety primitives for the opt-in synthetic VM rehearsal, never production deployment helpers.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {finished} from 'node:stream/promises';

const markerPath = '/run/circle-hub-synthetic-vm';
const markerText = 'circle-hub-synthetic-only-v1\n';

function commandStatus(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env, shell:false, stdio:'ignore'});
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', () => {clearTimeout(timer); reject(new Error('VM 前置命令无法启动'));});
    child.once('close', code => {clearTimeout(timer); resolve(code ?? -1);});
  });
}

/** No injectable platform, marker, identity or runner: the opt-in gate must inspect the actual machine. */
export async function requireSyntheticVm(): Promise<void> {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24' || !process.getuid || process.getuid() === 0)
    throw new Error('真实 Hub 演练只允许 Linux VM 的 Node 24 非 root 专用账户');
  if (process.env.CIRCLE_HUB_TEST_REAL_VM !== 'synthetic-only') throw new Error('未显式选择合成 VM 演练');
  const file = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o644 || info.size !== Buffer.byteLength(markerText))
      throw new Error('合成 VM 授权标记属主、类型或权限不正确');
    if ((await file.readFile('utf8')) !== markerText) throw new Error('合成 VM 授权标记内容不正确');
  } finally {await file.close();}
  if (await commandStatus('/usr/bin/systemd-detect-virt', ['--vm', '--quiet'], {PATH:'/usr/bin:/bin', LANG:'C'}) !== 0)
    throw new Error('未识别到虚拟机，拒绝真实 Hub 演练');
}

export interface VmRoots {
  parent: string;
  source: string;
  target: string;
  unit: string;
  cleanup(): Promise<void>;
}

/** Gate first; retain inode identity so cleanup refuses a replaced path instead of deleting somebody else's root. */
export async function createVmRoots(): Promise<VmRoots> {
  await requireSyntheticVm();
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'ch-vm-'));
  await chmod(parent, 0o700);
  const identity = await lstat(parent);
  try {
    const source = join(parent, 's'), target = join(parent, 't');
    await mkdir(source, {mode:0o700}); await mkdir(target, {mode:0o700});
    return {parent, source, target, unit:`circle-hub-synthetic-${randomBytes(12).toString('hex')}`, async cleanup() {
      const current = await lstat(parent);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid)
        throw new Error('测试目录身份已改变，拒绝删除');
      await rm(parent, {recursive:true});
    }};
  } catch (error) {await rm(parent, {recursive:true}); throw error;}
}

/** Resource registration happens only after successful creation. Every cleanup failure remains visible. */
export class VmCleanup {
  private actions: {step:string; action:()=>Promise<void>}[] = [];
  register(step:string, action:()=>Promise<void>): void {this.actions.push({step, action});}
  async run(): Promise<void> {
    const failures: Error[] = [];
    for (const entry of this.actions.splice(0).reverse()) {
      try {await entry.action();} catch {failures.push(new Error(`清理失败：${entry.step}`));}
    }
    if (failures.length) throw new AggregateError(failures, '合成 VM 资源未清理完毕');
  }
}

export interface KeyPipeCommand {
  /** Absolute path of Node, with only the owned release CLI and non-secret flags in args. */
  node: string;
  args: string[];
  /** Explicit minimal environment; caller must never include the key or host credentials. */
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Direct process pipe. No key bytes are captured, converted to text, logged, put in env/argv, or written to disk. */
export async function pipeSyntheticKey(exporter:KeyPipeCommand, importer:KeyPipeCommand, timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('密钥管道超时范围无效');
  const spawnCommand = (spec:KeyPipeCommand) => spawn(spec.node, spec.args, {
    env:spec.env, cwd:spec.cwd, shell:false, stdio:['pipe','pipe','ignore'],
  });
  const source = spawnCommand(exporter), target = spawnCommand(importer);
  let failed = false;
  const stop = () => {source.kill('SIGKILL'); target.kill('SIGKILL');};
  // Install both error handlers immediately, before either child can emit an asynchronous spawn failure.
  const exit = (child: typeof source) => new Promise<number>((resolve) => {
    child.once('error', () => {failed = true; stop();});
    child.once('close', code => {if (code !== 0) {failed = true; stop();} resolve(code ?? -1);});
  });
  const sourceExit = exit(source), targetExit = exit(target);
  const timer = setTimeout(() => {failed = true; stop();}, timeoutMs);
  source.stdin.end();
  // Ignore importer output entirely: even an accidentally echoed key must never reach logs or diagnostics.
  target.stdout.resume();
  const stream = finished(source.stdout).catch(() => {failed = true; stop();});
  source.stdout.on('error', () => {failed = true; stop();});
  target.stdin.on('error', () => {failed = true; stop();});
  source.stdout.pipe(target.stdin);
  try {
    const codes = await Promise.all([sourceExit, targetExit]);
    await stream;
    if (failed || codes.some(code => code !== 0)) throw new Error('合成主密钥管道失败（不披露子进程输出）');
  } finally {clearTimeout(timer); stop(); source.stdout.destroy(); target.stdin.destroy();}
}
