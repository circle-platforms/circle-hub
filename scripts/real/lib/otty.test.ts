import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OttyError, createOtty, type Run } from './otty.ts';

/** A fake otty: records every call and answers like the real CLI (shapes taken from a live probe). */
function fake(screens: string[] = ['']) {
  const calls: string[][] = [];
  let screenIndex = 0;
  const run: Run = (args) => {
    calls.push(args);
    const [group, command] = args;
    if (group === 'tab' && command === 'new') return { status: 0, stdout: JSON.stringify({ command: 'tab new', data: { id: 't_1', index: 3 }, ok: true }), stderr: '' };
    if (group === 'pane' && command === 'list') return { status: 0, stdout: JSON.stringify({ command: 'pane list', data: [{ id: 'p_1', tab_id: 't_1' }], ok: true }), stderr: '' };
    if (group === 'pane' && command === 'capture') return { status: 0, stdout: screens[Math.min(screenIndex++, screens.length - 1)], stderr: '' };
    if (group === 'tab' && command === 'close') return { status: 0, stdout: '{}', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('openTab opens without focus, finds the pane and remembers it', () => {
  const { run, calls } = fake();
  const otty = createOtty({ run });
  const tab = otty.openTab({ title: 'review', cwd: '/work' });
  assert.deepEqual(tab, { tab: 't_1', pane: 'p_1' });
  assert.deepEqual(calls[0], ['tab', 'new', '--title', 'review', '--cwd', '/work', '--json', '--no-focus']);
  assert.deepEqual(otty.opened(), [tab]);
  assert.deepEqual(createOtty({ run }).openTab({ title: 't', cwd: '/w', command: 'zsh -l', focus: true }), tab);
});

test('typing and submitting go to our own panes only, submit is two calls', () => {
  const { run, calls } = fake();
  const otty = createOtty({ run });
  const { pane } = otty.openTab({ title: 't', cwd: '/w' });
  calls.length = 0;
  otty.submit(pane, 'hello');
  assert.deepEqual(calls, [
    ['pane', 'send-text', '--pane', pane, 'hello'],
    ['pane', 'send-keys', '--pane', pane, 'key:Enter'],
  ]);
  otty.key(pane, 'Esc');
  assert.deepEqual(calls.at(-1), ['pane', 'send-keys', '--pane', pane, 'key:Esc']);
  assert.throws(() => otty.type('p_someone_else', 'rm -rf /'), OttyError);
  assert.throws(() => otty.submit('p_someone_else', 'x'), OttyError);
  assert.throws(() => otty.screen('p_someone_else'), OttyError);
  assert.throws(() => otty.closeTab('t_other'), OttyError);
  assert.ok(!calls.some((c) => c.includes('p_someone_else')), 'nothing was sent to a pane we did not open');
});

test('screen reads the visible screen or the scrollback', () => {
  const { run, calls } = fake(['line one\nline two']);
  const otty = createOtty({ run });
  const { pane } = otty.openTab({ title: 't', cwd: '/w' });
  assert.equal(otty.screen(pane), 'line one\nline two');
  assert.deepEqual(calls.at(-1), ['pane', 'capture', '--pane', pane, '--scope', 'screen', '--trim']);
  otty.screen(pane, { scrollback: true, lines: 200 });
  assert.deepEqual(calls.at(-1), ['pane', 'capture', '--pane', pane, '--scope', 'scrollback', '--trim', '--lines', '200']);
});

test('waitFor polls until the screen matches, and reports a timeout with the last screen', async () => {
  const { run } = fake(['thinking', 'thinking', 'done: 62 items']);
  let t = 0;
  const otty = createOtty({ run, sleep: async (ms) => void (t += ms), now: () => t });
  const { pane } = otty.openTab({ title: 't', cwd: '/w' });
  const found = await otty.waitFor(pane, (s) => s.includes('done'), { timeoutMs: 10_000, intervalMs: 1000 });
  assert.equal(found.ok, true);
  assert.match(found.screen, /62 items/);
  assert.equal(t, 2000);
  const never = await createOtty({ run: fake(['busy']).run, sleep: async (ms) => void (t += ms), now: () => t }).waitFor(pane, () => false, { timeoutMs: 3000, intervalMs: 1000 }).catch((e) => e);
  assert.ok(never instanceof OttyError, 'a pane that this object did not open is refused even for reading');
});

test('a failing otty call becomes an OttyError with the exit code and no secret text', () => {
  const run: Run = () => ({ status: 7, stdout: '', stderr: 'send-text is disabled' });
  const otty = createOtty({ run });
  assert.throws(() => otty.openTab({ title: 't', cwd: '/w' }), (e: Error) => e instanceof OttyError && /退出码 7/.test(e.message));
});

test('closeTab closes only a tab we opened and forgets its pane', () => {
  const { run, calls } = fake();
  const otty = createOtty({ run });
  const tab = otty.openTab({ title: 't', cwd: '/w' });
  otty.closeTab(tab.tab);
  assert.deepEqual(calls.at(-1), ['tab', 'close', 't_1', '--force', '--yes']);
  assert.deepEqual(otty.opened(), []);
});
