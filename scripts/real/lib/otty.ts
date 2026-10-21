// Drives a terminal client inside Otty through its control CLI: open a tab of our own, type into it, read its screen, wait for text.
// Only panes this module opened are ever written to; an id that was not opened here is refused. The runner and the clock are
// injected so the logic is tested without a terminal.
import { spawnSync } from 'node:child_process';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Run = (args: string[]) => RunResult;

/** Runs the `otty` CLI without a shell. */
export function ottyRunner(bin = 'otty'): Run {
  return (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
  };
}

export class OttyError extends Error {}

function ok(r: RunResult, what: string): string {
  if (r.status !== 0) throw new OttyError(`otty ${what} 失败（退出码 ${r.status}）：${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

function json(text: string, what: string): { data: unknown } {
  try {
    return JSON.parse(text) as { data: unknown };
  } catch {
    throw new OttyError(`otty ${what} 的输出不是 JSON`);
  }
}

export interface OpenedTab {
  tab: string;
  pane: string;
}

export interface Otty {
  /** Opens a tab with its own title and working directory, without taking focus, and returns its tab and pane ids. */
  openTab(options: { title: string; cwd: string; command?: string; focus?: boolean }): OpenedTab;
  /** Types text without submitting. */
  type(pane: string, text: string): void;
  /** Presses one key; names are those of `otty pane send-keys`: Enter, Tab, Esc, Backspace, Up/Down/Left/Right, Home/End, PageUp/PageDown, Ctrl+<letter>, F1-F12. */
  key(pane: string, key: string): void;
  /** Types the text and presses Enter in a separate call, as a TUI composer needs. */
  submit(pane: string, text: string): void;
  /** The visible screen, or the screen plus scrollback when `scrollback` is true; trailing blanks trimmed. */
  screen(pane: string, options?: { scrollback?: boolean; lines?: number }): string;
  /** Polls the screen until `until` holds or the time runs out. */
  waitFor(pane: string, until: (screen: string) => boolean, options?: { timeoutMs?: number; intervalMs?: number }): Promise<{ ok: boolean; screen: string }>;
  closeTab(tab: string): void;
  /** Panes opened through this object. */
  opened(): OpenedTab[];
}

export interface OttyOptions {
  run?: Run;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createOtty(options: OttyOptions = {}): Otty {
  const run = options.run ?? ottyRunner();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const opened = new Map<string, OpenedTab>();

  const own = (pane: string): string => {
    if (!opened.has(pane)) throw new OttyError(`窗格 ${pane} 不是这里打开的，拒绝操作`);
    return pane;
  };

  const readScreen = (pane: string, scrollback: boolean, lines?: number): string => {
    const args = ['pane', 'capture', '--pane', own(pane), '--scope', scrollback ? 'scrollback' : 'screen', '--trim'];
    if (lines !== undefined) args.push('--lines', String(lines));
    return ok(run(args), 'pane capture');
  };

  return {
    openTab({ title, cwd, command, focus = false }) {
      const args = ['tab', 'new', '--title', title, '--cwd', cwd, '--json'];
      if (!focus) args.push('--no-focus');
      if (command !== undefined) args.push('--command', command);
      const created = json(ok(run(args), 'tab new'), 'tab new').data as { id?: string };
      if (typeof created?.id !== 'string') throw new OttyError('otty tab new 没有返回标签页编号');
      const panes = json(ok(run(['pane', 'list', '--json', '--tab', created.id]), 'pane list'), 'pane list').data as { id?: string }[];
      const pane = panes?.[0]?.id;
      if (typeof pane !== 'string') throw new OttyError('新标签页里找不到窗格');
      const tab = { tab: created.id, pane };
      opened.set(pane, tab);
      return tab;
    },
    type(pane, text) {
      ok(run(['pane', 'send-text', '--pane', own(pane), text]), 'pane send-text');
    },
    key(pane, key) {
      ok(run(['pane', 'send-keys', '--pane', own(pane), key.startsWith('key:') ? key : `key:${key}`]), 'pane send-keys');
    },
    submit(pane, text) {
      ok(run(['pane', 'send-text', '--pane', own(pane), text]), 'pane send-text');
      ok(run(['pane', 'send-keys', '--pane', own(pane), 'key:Enter']), 'pane send-keys');
    },
    screen(pane, o = {}) {
      return readScreen(pane, o.scrollback === true, o.lines);
    },
    async waitFor(pane, until, o = {}) {
      const timeout = o.timeoutMs ?? 60_000;
      const interval = o.intervalMs ?? 1000;
      const deadline = now() + timeout;
      let screen = readScreen(pane, false);
      while (!until(screen)) {
        if (now() >= deadline) return { ok: false, screen };
        await sleep(interval);
        screen = readScreen(pane, false);
      }
      return { ok: true, screen };
    },
    closeTab(tab) {
      const known = [...opened.values()].find((t) => t.tab === tab);
      if (!known) throw new OttyError(`标签页 ${tab} 不是这里打开的，拒绝关闭`);
      ok(run(['tab', 'close', tab, '--force', '--yes']), 'tab close');
      opened.delete(known.pane);
    },
    opened() {
      return [...opened.values()];
    },
  };
}
