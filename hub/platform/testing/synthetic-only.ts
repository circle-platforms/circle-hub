// Preload for restricted verification. This is a test tripwire, not a replacement for the OS sandbox or test audit.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, Socket } from 'node:net';

class SyntheticOnlyRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) { super('合成验证禁止访问真实平台资源'); this.name = 'SyntheticOnlyRefusal'; this.reason = reason; }
}

export function assertSyntheticCommand(command: unknown, shell = false): void {
  if (typeof command !== 'string') return;
  if (['security', 'launchctl'].includes(basename(command)) || (shell && /(?:^|[\s;|&])(?:\/usr\/bin\/|\/bin\/)?(?:security|launchctl)(?:\s|$)/.test(command))) throw new SyntheticOnlyRefusal('host_tool');
}

export function assertSyntheticPort(first: unknown): void {
  if (Array.isArray(first)) first = first[0];
  const value = first !== null && typeof first === 'object' ? (first as { port?: unknown }).port : first;
  if ((typeof value === 'string' || typeof value === 'number') && Number(value) === 7420) throw new SyntheticOnlyRefusal('persistent_port');
}

const protectedRoots = [join(homedir(), 'Library', 'Application Support', 'circle-hub'), join(homedir(), 'Library', 'Keychains'), join(homedir(), 'Library', 'LaunchAgents')];
export function assertSyntheticPath(value: unknown): void {
  const path = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof path !== 'string') return;
  const absolute = resolve(path);
  if (protectedRoots.some(root => absolute === root || absolute.startsWith(root + sep))) throw new SyntheticOnlyRefusal('persistent_data');
}

for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const) {
  const original = childProcess[method];
  Object.defineProperty(childProcess, method, { value: new Proxy(original, { apply(target, receiver, args) {
    assertSyntheticCommand(args[0], method === 'exec' || method === 'execSync');
    // Platform libpq tools use spawn. Suppress user password/service files even with socket/peer authentication.
    if ((method === 'spawn' || method === 'spawnSync') && typeof args[0] === 'string' && ['pg_dump', 'pg_restore', 'pg_ctl', 'pg_isready', 'psql'].includes(basename(args[0]))) {
      const index = Array.isArray(args[1]) ? 2 : 1;
      const options = args[index] ?? {};
      args[index] = { ...options, env: { ...(options.env ?? process.env), PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null', PGSYSCONFDIR: '/dev/null', PGSERVICE: undefined, PSQLRC: '/dev/null' } };
    }
    return Reflect.apply(target, receiver, args);
  } }) });
}
const twoPaths = new Set(['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'link', 'linkSync', 'symlink', 'symlinkSync']);
for (const module of [fs, fsPromises]) for (const [name, original] of Object.entries(module)) {
  if (typeof original !== 'function') continue;
  const check = (args: unknown[]) => { assertSyntheticPath(args[0]); if (twoPaths.has(name)) assertSyntheticPath(args[1]); };
  Object.defineProperty(module, name, { value: new Proxy(original, {
    apply(target, receiver, args) { check(args); return Reflect.apply(target, receiver, args); },
    construct(target, args, constructor) { check(args); return Reflect.construct(target, args, constructor); },
  }) });
}
for (const [prototype, method] of [[Server.prototype, 'listen'], [Socket.prototype, 'connect']] as const) {
  const original = prototype[method as keyof typeof prototype] as Function;
  Object.defineProperty(prototype, method, { value: new Proxy(original, { apply(target, receiver, args) {
    assertSyntheticPort(args[0]);
    return Reflect.apply(target, receiver, args);
  } }) });
}
syncBuiltinESMExports();
