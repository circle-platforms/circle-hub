// Linux isolation uses bubblewrap for mounts and namespaces, and AppArmor for an exec prohibition that applies before Node starts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { LINUX_LAUNCH_PROFILE, LINUX_POLICY_REVISION, LINUX_WORKER_PROFILE, LINUX_WORKER_RULES } from './policy.ts';

export const BWRAP = '/usr/bin/bwrap';
export const AA_EXEC = '/usr/bin/aa-exec';
export const LAUNCH_PROFILE = LINUX_LAUNCH_PROFILE;
export const WORKER_PROFILE = LINUX_WORKER_PROFILE;
export const LINUX_SHELL = process.platform === 'linux' ? realpathSync('/bin/sh') : '/bin/sh';

/** The administrator installs this host policy; the worker is stacked at exec, before Node creates any threads. */
export function linuxAppArmorPolicy(node: string, shell: string = LINUX_SHELL): string {
  if (createHash('sha256').update(LINUX_WORKER_RULES).digest('hex').slice(0, 12) !== LINUX_POLICY_REVISION) throw new Error('Linux worker policy revision does not match its rules');
  // AppArmor expands variables and glob metacharacters even inside quotes. Refuse paths that need policy escaping.
  for (const path of [node, shell, BWRAP]) if (!isAbsolute(path) || !/^\/[A-Za-z0-9_./+ -]+$/.test(path)) throw new Error('invalid executable path for AppArmor policy');
  const q = (path: string): string => JSON.stringify(path);
  const workerRules = LINUX_WORKER_RULES.split('\n').filter(Boolean).map(line => `  ${line}\n`).join('');
  return `abi <abi/4.0>,\nprofile ${LAUNCH_PROFILE} flags=(attach_disconnected,mediate_deleted) {\n  userns,\n  capability,\n  network,\n  mount,\n  umount,\n  pivot_root,\n  ptrace,\n  signal,\n  file,\n  ${q(BWRAP)} ix,\n  ${q(shell)} ix,\n  ${q(node)} ix,\n  change_profile ${q(node)} -> &${WORKER_PROFILE},\n}\nprofile ${WORKER_PROFILE} flags=(attach_disconnected,mediate_deleted) {\n${workerRules}}\n`;
}

let libraryCache: string[] | undefined;
/** ldd is run only on the host's trusted Node and shell executables, never on pack bytes. */
export function linuxRuntimeLibraries(node: string, shell: string = LINUX_SHELL): string[] {
  if (libraryCache) return libraryCache;
  const libraries = new Set<string>();
  for (const binary of [node, shell]) {
    const result = spawnSync('/usr/bin/ldd', [binary], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('cannot resolve Linux runtime libraries');
    const interpreter = result.stdout.split('\n').map(line => /^\s*(\/[^\s]+)\s+\(0x[\da-f]+\)\s*$/i.exec(line)?.[1]).find(Boolean);
    if (!interpreter || !existsSync(interpreter)) throw new Error('Linux dynamic interpreter is unavailable');
    // The empty sandbox has no ld.so.cache. Resolve exactly what its loader can find without that cache.
    const uncached = spawnSync(interpreter, ['--inhibit-cache', '--list', binary], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (uncached.error || uncached.status !== 0) throw new Error('cannot resolve uncached Linux runtime libraries');
    for (const line of uncached.stdout.split('\n')) {
      if (!line.trim() || line.includes('linux-vdso') || /^\s*\(0x[\da-f]+\)\s*$/i.test(line)) continue;
      if (line.includes('not found')) throw new Error('Linux runtime library is missing');
      const match = /(?:=>\s*)?(\/[^\s]+)\s+\(0x[\da-f]+\)\s*$/i.exec(line);
      if (!match) throw new Error('unrecognised Linux runtime library declaration');
      const path = match[1];
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error('Linux runtime library is not a file');
      libraries.add(path); libraries.add(realpathSync(path));
    }
    libraries.add(interpreter); libraries.add(realpathSync(interpreter));
  }
  libraryCache = [...libraries].sort();
  return libraryCache;
}

/** All directories are empty mount points; only named files and directories are mounted read-only. */
export function linuxBubblewrapArgs(node: string, program: string[], reads: string[], writable: string[] = []): string[] {
  const bindings = [...new Set([node, LINUX_SHELL, ...linuxRuntimeLibraries(node), ...reads, ...writable])];
  const parents = new Set<string>();
  for (const item of bindings) {
    if (!isAbsolute(item) || !existsSync(item)) throw new Error('Linux sandbox binding is missing');
    for (let dir = dirname(item); dir !== '/'; dir = dirname(dir)) parents.add(dir);
    if (statSync(item).isDirectory()) parents.add(item);
  }
  const dirs = [...parents].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
    ...dirs.flatMap(dir => ['--dir', dir]),
    ...bindings.flatMap(path => [writable.includes(path) ? '--bind' : '--ro-bind', path, path]),
    '--proc', '/proc', '--dev', '/dev',
    LINUX_SHELL, '-c', 'set -eu; exec 3</proc/self/attr/apparmor/current; printf "stack %s" "$1" > /proc/self/attr/apparmor/exec; shift; exec "$@"', 'sandbox', WORKER_PROFILE, node, ...program,
  ];
}

export function linuxToolsPresent(): boolean {
  try { for (const path of [BWRAP, AA_EXEC]) { const s=statSync(path); if (!s.isFile() || !(s.mode & constants.S_IXUSR)) return false; } return true; }
  catch { return false; }
}

if (import.meta.main) {
  if (process.platform !== 'linux') throw new Error('Linux AppArmor policy can only be generated on Linux');
  process.stdout.write(linuxAppArmorPolicy(realpathSync(process.execPath)));
}
