// Children an earlier Hub process left behind (it died without stopping them): sandboxed processes whose parent is now pid 1
// (launchd or init) and whose command line grants read access to this installation's bootstrap. The Hub sweeps them at start.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { BOOTSTRAP } from './isolation.ts';

interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string[] | string;
}

async function listDarwin(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    const ps = spawn('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
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

/** Kills leftover sandbox children of an earlier Hub process of this installation; returns how many were signalled. */
export async function sweepOrphans(): Promise<number> {
  const marker = `--allow-fs-read=${BOOTSTRAP}`;
  const processes = process.platform === 'linux' ? await listLinux() : process.platform === 'darwin' ? await listDarwin() : [];
  let killed = 0;
  for (const p of processes) {
    if (p.ppid !== 1 || p.pid === process.pid) continue;
    // argv when known; otherwise the command text, matched as a whole word.
    const ours = Array.isArray(p.args) ? p.args.includes(marker) : ` ${p.args} `.includes(` ${marker} `);
    if (!ours) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Already gone or not ours to signal.
    }
  }
  return killed;
}
