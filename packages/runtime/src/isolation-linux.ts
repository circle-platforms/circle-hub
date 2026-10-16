import {constants} from 'node:fs';
import {access, chmod, mkdtemp, realpath, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {ApiError} from '../../contracts/src/index.ts';
import {landlockHelper, seccompProgram} from './linux-harden.ts';

export const bubblewrapInstallHint = 'Install bubblewrap and retry. Debian/Ubuntu: sudo apt-get install bubblewrap. Fedora/RHEL: sudo dnf install bubblewrap. Arch Linux: sudo pacman -S bubblewrap.';
export const bubblewrapMissingMessage = `Bubblewrap (bwrap) is not installed, so this command cannot be isolated. ${bubblewrapInstallHint} Hub will not run it without process isolation. See docs/quickstart.md.`;
const namespaceMessage = 'Bubblewrap is installed but this kernel refused a user namespace, so hub will not run the command without isolation. On Ubuntu 24.04, allow unprivileged user namespaces for this boot: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0. See docs/quickstart.md.';
const networkMessage = 'This Linux host cannot restrict outbound TCP to the approved loopback ports (landlock network rules or the local helper compiler are unavailable). Hub will not share the host network without that restriction. Install gcc (or cc) and use a kernel with landlock ABI 4 or newer. See docs/quickstart.md.';

const systemReads = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc/ssl', '/etc/ca-certificates', '/etc/ssl/certs', '/etc/hosts', '/etc/resolv.conf', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d'];
const privateRoots = new Set(['/', '/tmp', '/home', '/root', '/run', '/sandbox', '/proc', '/dev']);

export interface LinuxIsolationOptions {bwrapPath?: string | null}
interface Mount {src: string; dest: string; rw: boolean}

let usableBwrap: Promise<string> | undefined;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ApiError('SANDBOX_UNAVAILABLE', message, {adapter: 'bubblewrap', ...details});
}

function runQuiet(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio: 'ignore'});
    const timer = setTimeout(() => {child.kill('SIGKILL'); resolve(false);}, timeoutMs);
    child.once('error', () => {clearTimeout(timer); resolve(false);});
    child.once('exit', code => {clearTimeout(timer); resolve(code === 0);});
  });
}

async function locateBwrap(): Promise<string | null> {
  const candidates = new Set<string>();
  for (const directory of (process.env.PATH ?? '').split(':')) if (directory) candidates.add(join(directory, 'bwrap'));
  candidates.add('/usr/bin/bwrap');
  candidates.add('/bin/bwrap');
  for (const candidate of candidates) {
    try {await access(candidate, constants.X_OK); return candidate;} catch {/* keep looking */}
  }
  return null;
}

async function assertUsable(path: string): Promise<void> {
  // /usr/bin/true is dynamically linked. The probe also mounts the loader
  // directories so a missing interpreter is not reported as a namespace refusal.
  const args = ['--unshare-user', '--die-with-parent'];
  for (const root of ['/usr', '/lib', '/lib64']) {
    try {await access(root); args.push('--ro-bind', root, root);} catch {/* Optional on this distribution. */}
  }
  args.push('--', '/usr/bin/true');
  const ok = await runQuiet(path, args, 5_000);
  if (!ok) fail(namespaceMessage);
}

async function resolveBwrap(explicit: string | null | undefined): Promise<string> {
  if (explicit === null) fail(bubblewrapMissingMessage, {install: bubblewrapInstallHint});
  if (explicit) {await assertUsable(explicit); return explicit;}
  usableBwrap ??= (async () => {
    const found = await locateBwrap();
    if (!found) fail(bubblewrapMissingMessage, {install: bubblewrapInstallHint});
    await assertUsable(found);
    return found;
  })();
  return usableBwrap;
}

function loopbackPort(value: string): number {
  let url: URL;
  try {url = new URL(value);} catch {fail('Only approved loopback execution endpoints are supported');}
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.username || url.password) fail('Only approved loopback execution endpoints are supported');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Only approved loopback execution endpoints are supported');
  return port;
}

function safePath(path: string): string {
  if (path.includes('\n') || path.includes('\r') || path.includes('\t')) fail('Isolation paths cannot contain control characters');
  return path;
}

function coveredBy(mounts: Mount[], dest: string, predicate: (mount: Mount) => boolean): boolean {
  return mounts.some(mount => predicate(mount) && (dest === mount.dest || dest.startsWith(`${mount.dest}/`)));
}

function addMount(mounts: Mount[], src: string, rw: boolean): void {
  const dest = safePath(src);
  const existing = mounts.find(mount => mount.dest === dest);
  if (existing) {if (rw) existing.rw = true; return;}
  if (!rw && coveredBy(mounts, dest, mount => !mount.rw)) return;
  if (!rw && coveredBy(mounts, dest, mount => mount.rw)) return;
  mounts.push({src: dest, dest, rw});
}

async function optionalMount(mounts: Mount[], path: string): Promise<void> {
  try {await access(path); addMount(mounts, path, false);} catch {/* Optional OS resources. */}
}

function parentDirs(dest: string, mounts: Mount[], created: Set<string>): string[] {
  const args: string[] = [];
  const parts = dest.split('/').filter(Boolean);
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current += `/${parts[index]}`;
    if (privateRoots.has(current) || created.has(current) || coveredBy(mounts, current, () => true)) continue;
    args.push('--dir', current);
    created.add(current);
  }
  return args;
}

export async function linuxIsolatedProcess(command: string, args: string[], policy: {read: string[]; write: string[]; network: string[]}, options: LinuxIsolationOptions = {}): Promise<{command: string; args: string[]}> {
  const bwrap = await resolveBwrap(options.bwrapPath);
  const ports = [...new Set(policy.network.map(loopbackPort))];
  const executable = safePath(await realpath(command));
  const mounts: Mount[] = [];
  for (const path of systemReads) await optionalMount(mounts, path);
  const executableDir = dirname(executable);
  if (executableDir !== '/') addMount(mounts, executableDir, false);
  else addMount(mounts, executable, false);
  for (const path of policy.read) addMount(mounts, safePath(await realpath(path)), false);
  for (const path of policy.write) addMount(mounts, safePath(await realpath(path)), true);

  const helper = await landlockHelper();
  if (ports.length && (!helper.binary || helper.abi < 4)) fail(networkMessage);
  const useHelper = Boolean(helper.binary);
  const sandboxRoot = useHelper ? await mkdtemp(join(tmpdir(), 'circle-hub-sandbox-')) : '';
  const rules: string[] = [];
  const accessByDirectory = new Map<string, 'R' | 'W'>();
  const grant = (kind: 'R' | 'W', path: string) => {
    if (path === '/') fail('Isolation cannot grant the filesystem root');
    const current = accessByDirectory.get(path);
    if (current !== 'W') accessByDirectory.set(path, kind === 'W' ? 'W' : current ?? 'R');
  };
  if (useHelper) {
    // Landlock path rules attach to directories. A file rule returns EINVAL,
    // so a file grants its parent and the mount keeps sibling files out.
    grant('W', '/tmp');
    grant('W', '/dev');
    grant('R', '/proc');
    grant('R', '/sandbox');
    const writes = mounts.filter(mount => mount.rw).map(mount => mount.dest);
    for (const mount of mounts) {
      const metadata = await stat(mount.src);
      const directory = metadata.isDirectory() ? mount.dest : dirname(mount.dest);
      const ancestorOfWrite = !mount.rw && writes.some(dest => dest === mount.dest || dest.startsWith(`${mount.dest}/`));
      grant(mount.rw || ancestorOfWrite ? 'W' : 'R', directory);
    }
    for (const [directory, kind] of accessByDirectory) {
      if (kind !== 'W') continue;
      for (const [parent, parentKind] of accessByDirectory) {
        if (parentKind === 'R' && directory.startsWith(`${parent}/`)) accessByDirectory.set(parent, 'W');
      }
    }
    for (const [directory, kind] of accessByDirectory) rules.push(`${kind}\t${safePath(directory)}`);
    for (const port of ports) rules.push(`P\t${port}`);
    const filter = seccompProgram(ports.length > 0);
    if (filter) {
      const seccompHost = join(sandboxRoot, 'seccomp.bpf');
      await writeFile(seccompHost, filter, {mode: 0o600});
      await chmod(seccompHost, 0o600);
      rules.push('S\t/sandbox/seccomp.bpf');
    }
  }

  const bwrapArgs = [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--disable-userns', '--die-with-parent', '--cap-drop', 'ALL',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/root', '--tmpfs', '/run',
    '--dir', '/sandbox',
  ];
  if (!ports.length) bwrapArgs.push('--unshare-net');
  const created = new Set<string>(privateRoots);
  for (const mount of mounts) {
    bwrapArgs.push(...parentDirs(mount.dest, mounts, created));
    bwrapArgs.push(mount.rw ? '--bind' : '--ro-bind', mount.src, mount.dest);
    created.add(mount.dest);
  }

  let commandInside = executable;
  let commandArgs = args;
  if (useHelper && helper.binary) {
    const policyHost = join(sandboxRoot, 'policy');
    await writeFile(policyHost, `${rules.join('\n')}\n`, {mode: 0o600});
    await chmod(policyHost, 0o600);
    bwrapArgs.push(
      '--ro-bind', helper.binary, '/sandbox/landlock-apply',
      '--ro-bind', policyHost, '/sandbox/policy',
    );
    if (rules.some(line => line.startsWith('S\t'))) bwrapArgs.push('--ro-bind', join(sandboxRoot, 'seccomp.bpf'), '/sandbox/seccomp.bpf');
    commandInside = '/sandbox/landlock-apply';
    commandArgs = ['/sandbox/policy', '--', executable, ...args];
  }
  bwrapArgs.push('--', commandInside, ...commandArgs);
  return {command: bwrap, args: bwrapArgs};
}
