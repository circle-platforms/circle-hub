// Children an earlier Hub process left behind (it died without stopping them): sandboxed processes whose parent is now pid 1
// (launchd or init) and whose command line grants read access to this installation's bootstrap. The Hub sweeps them at start.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { BOOTSTRAP } from './isolation.ts';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** argv when known (Linux); otherwise the command text as ps prints it (macOS). */
  args: string[] | string;
}

// ps runs with a fixed environment, never the Hub's, so nothing the Hub was started with changes what it prints. The one
// variable is the character type: ps writes command lines through vis(3), which in the C locale (an empty environment)
// prints every byte outside ASCII in meta notation (开 as M-eM-<M^@), and a bootstrap under such a path would never match.
// Under UTF-8, which every macOS release has, vis leaves printable characters as they are (multibyte since OS X 10.12).
const PS_ENVIRONMENT = { LC_CTYPE: 'UTF-8' };

async function listDarwin(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    const ps = spawn('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { stdio: ['ignore', 'pipe', 'ignore'], env: PS_ENVIRONMENT });
    let text = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk: string) => (text += chunk));
    ps.on('error', () => resolve([]));
    ps.on('close', () => {
      const out: ProcessInfo[] = [];
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
        if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
      }
      resolve(out);
    });
  });
}

async function listLinux(): Promise<ProcessInfo[]> {
  const out: ProcessInfo[] = [];
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const args = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0');
      out.push({ pid: Number(name), ppid, args });
    } catch {
      // Gone.
    }
  }
  return out;
}

/** Every process with its parent and its command line: argv from /proc on Linux, the text ps prints on macOS. */
export function listProcesses(): Promise<ProcessInfo[]> {
  return process.platform === 'linux' ? listLinux() : process.platform === 'darwin' ? listDarwin() : Promise.resolve([]);
}

/** Whether a command line carries `arg` as one whole argument: an argv entry, or a word of the command text. */
export function carries(p: ProcessInfo, arg: string): boolean {
  return Array.isArray(p.args) ? p.args.includes(arg) : ` ${p.args} `.includes(` ${arg} `);
}

/** Kills leftover sandbox children of an earlier Hub process of this installation; returns how many were signalled. */
export function sweepOrphans(): Promise<number> {
  return sweepOrphansOf(BOOTSTRAP);
}

/** sweepOrphans for the installation whose bootstrap is at `bootstrap` (a test passes one of its own). */
export async function sweepOrphansOf(bootstrap: string): Promise<number> {
  const marker = `--allow-fs-read=${bootstrap}`;
  let killed = 0;
  for (const p of await listProcesses()) {
    if (p.ppid !== 1 || p.pid === process.pid || !carries(p, marker)) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Already gone or not ours to signal.
    }
  }
  return killed;
}
