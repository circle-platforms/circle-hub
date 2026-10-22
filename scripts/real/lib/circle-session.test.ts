import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasComposer, isBusy, isIdle, startCircle } from './circle-session.ts';
import { createOtty, type Run } from './otty.ts';

const COMPOSER_IDLE = '╭────────────╮\n│ › ▏        │\n╰──── auto ─╯\n ↑ 0 · ↓ 0 · N/A · cache 0.0% · ctx 10/N/A';
const COMPOSER_BUSY = '╭──Processing… · 5s · ↓ 0────╮\n│ › ▏        │\n╰──── auto ─╯\n ↑ N/A · ↓ 0';
const NOTICE = ' what\'s new\n esc · dismiss\n' + COMPOSER_IDLE;

test('the screen predicates follow the composer border', () => {
  assert.ok(hasComposer(COMPOSER_IDLE) && hasComposer(COMPOSER_BUSY));
  assert.ok(isIdle(COMPOSER_IDLE) && !isIdle(COMPOSER_BUSY));
  assert.ok(isBusy(COMPOSER_BUSY) && !isBusy(COMPOSER_IDLE));
  assert.ok(isBusy('Retrying… timeout 1/10\n' + COMPOSER_IDLE));
  assert.ok(isBusy('╭──Reflecting… · 2s · ↓ 20────╮\n│ › ▏        │\n╰──── auto ─╯') && isBusy('╭──Thinking… · 12s · ↓ 0────╮'), 'the spinner word is not fixed');
  assert.ok(isBusy('╭──Cogitating… · 1m 2s · ↓ 2.9k────╮') && isBusy('╭──Thinking… · 1h 3m 20s · ↓ 40k────╮'), 'minutes and hours of a long turn');
  assert.ok(!isBusy('我们先想想…… 这一步花了 5s'), 'text of the conversation is not a spinner');
  assert.ok(!hasComposer('plain shell $ '));
});

function fakeTerminal(screens: string[]) {
  const sent: string[][] = [];
  let i = 0;
  const run: Run = (args) => {
    sent.push(args);
    const [g, c] = args;
    if (g === 'tab' && c === 'new') return { status: 0, stdout: JSON.stringify({ data: { id: 't_1' } }), stderr: '' };
    if (g === 'pane' && c === 'list') return { status: 0, stdout: JSON.stringify({ data: [{ id: 'p_1' }] }), stderr: '' };
    if (g === 'pane' && c === 'capture') return { status: 0, stdout: screens[Math.min(i++, screens.length - 1)], stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, sent };
}

function clock() {
  let t = 0;
  return { sleep: async (ms: number) => void (t += ms), now: () => t };
}

test('start dismisses the first-run notice, then ask returns after busy then idle twice', async () => {
  const { run, sent } = fakeTerminal([NOTICE, COMPOSER_IDLE, COMPOSER_IDLE, COMPOSER_BUSY, COMPOSER_BUSY, COMPOSER_IDLE + '\n answer', COMPOSER_IDLE + '\n answer', COMPOSER_IDLE + '\n answer']);
  const c = clock();
  const session = await startCircle({ otty: createOtty({ run, ...c }), home: '/h', cwd: '/w', cli: '/c/dist/cli.js', title: 't', ...c });
  assert.ok(sent.some((a) => a.join(' ').includes("CIRCLE_HOME='/h'") && a.join(' ').includes("'/c/dist/cli.js'")), 'the client starts with the dedicated home');
  assert.ok(sent.some((a) => a[1] === 'send-keys' && a.includes('key:Esc')), 'the notice is dismissed');
  const result = await session.ask('review it');
  assert.equal(result.done, true);
  assert.equal(result.sawBusy, true);
  assert.match(result.screen, /answer/);
});

test('a slash command that never shows the busy border still ends after the screen stays idle', async () => {
  const { run } = fakeTerminal([COMPOSER_IDLE]);
  const c = clock();
  const session = await startCircle({ otty: createOtty({ run, ...c }), home: '/h', cwd: '/w', cli: 'cli.js', title: 't', ...c });
  const result = await session.ask('/mcp', { timeoutMs: 60_000 });
  assert.deepEqual([result.done, result.sawBusy], [true, false]);
});

test('ask reports a timeout with the last screen when the turn never ends', async () => {
  const { run } = fakeTerminal([COMPOSER_IDLE, COMPOSER_BUSY]);
  const c = clock();
  const session = await startCircle({ otty: createOtty({ run, ...c }), home: '/h', cwd: '/w', cli: 'cli.js', title: 't', ...c });
  const result = await session.ask('long', { timeoutMs: 10_000 });
  assert.deepEqual([result.done, result.sawBusy], [false, true]);
  assert.match(result.screen, /Processing/);
});

test('start fails clearly when no composer appears', async () => {
  const { run } = fakeTerminal(['$ ']);
  const c = clock();
  await assert.rejects(startCircle({ otty: createOtty({ run, ...c }), home: '/h', cwd: '/w', cli: 'cli.js', title: 't', ...c }), /输入框/);
});

test('shell quoting keeps a home with a quote in its name from breaking the command', async () => {
  const { run, sent } = fakeTerminal([COMPOSER_IDLE]);
  const c = clock();
  await startCircle({ otty: createOtty({ run, ...c }), home: "/tmp/it's", cwd: '/w', cli: 'cli.js', title: 't', ...c });
  assert.ok(sent.some((a) => a.join(' ').includes(`CIRCLE_HOME='/tmp/it'\\''s'`)));
});
