// A Circle terminal session in an Otty tab of our own: start the real client with a dedicated data folder, send prompts, wait for
// the turn to end, read the screen. What the screen shows was observed on Circle 1.10: while a turn runs the top border of the
// composer reads "Processing… · 5s · ↓ 0" (or "Retrying…"), when it is idle the border is plain and the footer carries "ctx".
import type { Otty, OpenedTab } from './otty.ts';

// While a turn runs the top border of the composer carries a spinner word, the elapsed seconds and the output tokens
// ("╭──Processing… · 5s · ↓ 0", "Cogitating… · 1m 2s · ↓ 2.9k", "Retrying…"): the word changes, the shape does not.
export const BUSY = /Retrying…|…\s·\s(?:\d+h\s)?(?:\d+m\s)?\d+s\s·\s↓/;
const COMPOSER_TOP = /╭[─ ]/;
const COMPOSER_LINE = /│ › /;

export const hasComposer = (screen: string): boolean => COMPOSER_TOP.test(screen) && COMPOSER_LINE.test(screen);
export const isBusy = (screen: string): boolean => BUSY.test(screen);
export const isIdle = (screen: string): boolean => hasComposer(screen) && !isBusy(screen);
const hasNotice = (screen: string): boolean => /esc · dismiss/.test(screen);

export interface CircleSessionOptions {
  otty: Otty;
  /** The dedicated CIRCLE_HOME. */
  home: string;
  /** Working directory of the session (an empty folder the home trusts). */
  cwd: string;
  /** Path of Circle's dist/cli.js. */
  cli: string;
  title: string;
  node?: string;
  /** More environment variables for the client, as NAME=value words; values must not need quoting. */
  env?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AskResult {
  /** The turn ended (idle was seen after it started). */
  done: boolean;
  /** Whether the busy indicator was ever seen. */
  sawBusy: boolean;
  screen: string;
}

export interface CircleSession {
  readonly tab: OpenedTab;
  /** Types a prompt (or a slash command), presses Enter and waits for the turn to end. */
  ask(prompt: string, options?: { timeoutMs?: number; pollMs?: number; startGraceMs?: number }): Promise<AskResult>;
  screen(options?: { scrollback?: boolean }): string;
  exit(): Promise<void>;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export async function startCircle(options: CircleSessionOptions): Promise<CircleSession> {
  const { otty } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const tab = otty.openTab({ title: options.title, cwd: options.cwd });
  const env = { CIRCLE_HOME: options.home, CIRCLE_NO_MODELS_REFRESH: '1', CIRCLE_NO_UPDATE_CHECK: '1', ...options.env };
  const words = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`);
  otty.submit(tab.pane, `${words.join(' ')} ${quote(options.node ?? 'node')} ${quote(options.cli)}`);
  const up = await otty.waitFor(tab.pane, hasComposer, { timeoutMs: 40_000, intervalMs: 500 });
  if (!up.ok) throw new Error('Circle 没有在 40 秒内出现输入框');
  if (hasNotice(up.screen)) {
    otty.key(tab.pane, 'Esc');
    await sleep(500);
  }

  return {
    tab,
    screen: (o) => otty.screen(tab.pane, o),
    async ask(prompt, o = {}) {
      const timeout = o.timeoutMs ?? 600_000;
      const poll = o.pollMs ?? 1000;
      const grace = o.startGraceMs ?? 15_000;
      otty.submit(tab.pane, prompt);
      const started = now();
      let sawBusy = false;
      let screen = otty.screen(tab.pane);
      let idleSeen = 0;
      while (now() - started < timeout) {
        await sleep(poll);
        screen = otty.screen(tab.pane);
        if (isBusy(screen)) {
          sawBusy = true;
          idleSeen = 0;
          continue;
        }
        if (!isIdle(screen)) continue;
        // Idle twice in a row after a busy phase, or idle for the whole grace period without ever being busy (a slash command).
        idleSeen += 1;
        if (sawBusy && idleSeen >= 2) return { done: true, sawBusy, screen };
        if (!sawBusy && now() - started >= Math.min(grace, 2_000) && idleSeen >= 2) return { done: true, sawBusy, screen };
      }
      return { done: false, sawBusy, screen };
    },
    async exit() {
      otty.submit(tab.pane, '/exit');
      await sleep(1500);
      otty.closeTab(tab.tab);
    },
  };
}
