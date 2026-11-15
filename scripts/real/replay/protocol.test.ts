import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookIdentityEnvironment, hookRegistration, interpretCircle118, mcpToolName, preToolUseInput118, readPreToolUseAnswer } from './protocol.ts';
import { readCandidate } from './compare.ts';
import { ReplayError } from './types.ts';

const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
const deny = (reason?: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } });
const block = interpretCircle118({ name: 'guard', onFailure: 'block' });
const carryOn = interpretCircle118({ name: 'guard', onFailure: 'continue' });

test('a PreToolUse answer is read as Circle 1.18.0-local.2 reads it', () => {
  assert.deepEqual(block(0, '', ''), { decision: 'none', reason: '', failed: false });
  assert.deepEqual(block(0, '{}', 'warning'), { decision: 'none', reason: '', failed: false });
  assert.deepEqual(block(0, 'plain text for the log', ''), { decision: 'none', reason: '', failed: false });
  assert.deepEqual(block(0, allow, ''), { decision: 'allow', reason: '', failed: false });
  assert.deepEqual(block(0, deny('no way'), ''), { decision: 'deny', reason: 'no way', failed: false });
  assert.deepEqual(block(0, deny(), ''), { decision: 'deny', reason: 'hook denied', failed: false });
  assert.deepEqual(block(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sure?' } }), ''), { decision: 'ask', reason: 'sure?', failed: false });
  // `defer` is ignored: Circle cannot hold a call for later
  assert.deepEqual(block(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }), ''), { decision: 'none', reason: '', failed: false });
  // a rewrite beside a decision that lets the call run
  assert.deepEqual(block(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'x' } } }), ''), { decision: 'allow', reason: '', failed: false, rewritten: true });
  // the top-level form of the format before: it still counts, and is marked
  assert.deepEqual(block(0, JSON.stringify({ decision: 'block', reason: 'old way' }), ''), { decision: 'deny', reason: 'old way', failed: false, legacy: true });
  assert.deepEqual(block(0, JSON.stringify({ decision: 'approve' }), ''), { decision: 'allow', reason: '', failed: false, legacy: true });
});
test('exit 2 denies with the standard error, whatever the JSON says', () => {
  assert.deepEqual(block(2, '', ' by exit code \n'), { decision: 'deny', reason: 'by exit code', failed: false });
  assert.deepEqual(block(2, '', ''), { decision: 'deny', reason: 'hook exited 2', failed: false });
  assert.deepEqual(block(2, deny('from json'), 'from stderr'), { decision: 'deny', reason: 'from json', failed: false });
  assert.deepEqual(block(2, allow, 'from stderr'), { decision: 'deny', reason: 'from stderr', failed: false });
  assert.deepEqual(carryOn(2, '', 'refused'), { decision: 'deny', reason: 'refused', failed: false });
});
test('a failed hook denies when it blocks on failure and lets the call go ahead otherwise', () => {
  const wrong: [string, string][] = [
    ['unreadable JSON', '{"hookSpecificOutput": '],
    ['text after the JSON', '{"a":1} trailing'],
    ['the wrong event name', JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } })],
    ['an unknown decision', JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'maybe' } })],
    ['a reason that is not text', JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 7 } })],
    ['a top-level reason that is not text', JSON.stringify({ reason: false })],
    ['an unknown top-level decision', JSON.stringify({ decision: 'perhaps' })],
  ];
  for (const [name, stdout] of wrong) {
    const closed = block(0, stdout, '');
    assert.deepEqual([closed.decision, closed.failed], ['deny', true], name);
    assert.match(closed.reason, /^hook guard failed; blocking because onFailure is "block": /, name);
    assert.deepEqual(carryOn(0, stdout, ''), { decision: 'none', reason: '', failed: true }, name);
  }
  assert.match(block(1, '', 'it crashed\nsecond line').reason, /exited 1: it crashed$/);
  assert.deepEqual(carryOn(1, '', 'crash'), { decision: 'none', reason: '', failed: true });
  assert.equal(block(null, '', '').reason, 'hook guard failed; blocking because onFailure is "block": exited unknown');
  // another exit code with a JSON answer: the answer decides, unless the hook blocks on failure
  assert.deepEqual(carryOn(1, deny('exit 1 but said so'), ''), { decision: 'deny', reason: 'exit 1 but said so', failed: false });
  assert.deepEqual(block(1, deny('exit 1 but said so'), '').failed, true);
});
test('a hook answer with a wrong field is no answer at all', () => {
  assert.ok('invalid' in readPreToolUseAnswer({ continue: 'yes' }));
  assert.ok('invalid' in readPreToolUseAnswer({ hookSpecificOutput: 'text' }));
  assert.ok('invalid' in readPreToolUseAnswer({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: [] } }));
  assert.ok('invalid' in readPreToolUseAnswer({ updated_input: 'x' }));
  assert.ok('invalid' in readPreToolUseAnswer({ user_message: 3 }));
  assert.deepEqual(readPreToolUseAnswer({ continue: false, systemMessage: 'shown to you' }), { answer: {}, legacy: false });
});
test('the input of a PreToolUse hook has the fields of Circle 1.18, in a subagent with the agent', () => {
  const root = { root: 'conversation', session: 'conversation', permissionMode: 'bypassPermissions', cwd: '/work', toolName: 'execute', toolInput: { command: 'ls' }, toolUseId: 'call-1', paths: ['/work/a'] };
  assert.deepEqual(preToolUseInput118(root), { session_id: 'conversation', cwd: '/work', permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', tool_name: 'execute', tool_input: { command: 'ls' }, tool_use_id: 'call-1', paths: ['/work/a'] });
  assert.deepEqual(Object.keys(preToolUseInput118({ ...root, session: 'child', agentType: 'explore' })), ['session_id', 'cwd', 'permission_mode', 'hook_event_name', 'agent_id', 'agent_type', 'tool_name', 'tool_input', 'tool_use_id', 'paths']);
  const child = preToolUseInput118({ ...root, session: 'child', agentType: 'explore' });
  assert.deepEqual([child.session_id, child.agent_id, child.agent_type], ['conversation', 'child', 'explore']);
  assert.equal(preToolUseInput118({ ...root, session: 'child' }).agent_type, 'general-purpose');
  assert.deepEqual(preToolUseInput118({ ...root, paths: undefined }).paths, []);
  assert.deepEqual(hookIdentityEnvironment({ root: 'conversation', session: 'conversation', cwd: '/work' }), { CIRCLE_PROJECT_DIR: '/work', CIRCLE_SESSION_ID: 'conversation' });
  assert.deepEqual(hookIdentityEnvironment({ root: 'conversation', session: 'child', cwd: '/work' }), { CIRCLE_PROJECT_DIR: '/work', CIRCLE_SESSION_ID: 'conversation', CIRCLE_AGENT_ID: 'child' });
});
test('the tools of an MCP server are named as Circle 1.18 names them', () => {
  assert.equal(mcpToolName('hub_start_run', 'hub'), 'mcp__hub__start_run');
  assert.equal(mcpToolName('hub_list_task_packs', 'hub'), 'mcp__hub__list_task_packs');
  assert.equal(mcpToolName('read_file', 'hub'), 'read_file');
  assert.equal(mcpToolName('hubble_x', 'hub'), 'hubble_x');
  assert.equal(mcpToolName('hub_start_run', 'other'), 'hub_start_run');
});
test('the guard hook is found in the candidate settings by the file it runs', () => {
  const settings = (hooks: unknown) => JSON.stringify({ hooks: { PreToolUse: hooks } });
  const guard = { type: 'command', name: 'ops tools guard', command: "node '/home/hooks/ops-allow.mjs'", timeout: 600, onFailure: 'block' };
  assert.deepEqual(hookRegistration(settings([{ hooks: [guard, { type: 'command', command: 'node other.mjs' }] }]), 'ops-allow.mjs'), { name: 'ops tools guard', onFailure: 'block', timeoutSeconds: 600 });
  assert.deepEqual(hookRegistration(settings([{ hooks: [{ type: 'command', command: 'node', args: ['/home/hooks/ops-allow.mjs'] }] }]), 'ops-allow.mjs'), { name: 'node', onFailure: 'continue' });
  assert.equal(hookRegistration(settings([{ hooks: [guard, guard] }]), 'ops-allow.mjs'), undefined, 'two hooks run the file');
  assert.equal(hookRegistration(settings([{ hooks: [guard] }]), 'another.mjs'), undefined);
  assert.equal(hookRegistration('not json', 'ops-allow.mjs'), undefined);
  assert.equal(hookRegistration('{}', 'ops-allow.mjs'), undefined);
});
test('a candidate is one file, or a folder of files, and never a link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circle-replay-candidate-test-'));
  try {
    writeFileSync(join(dir, 'single.txt'), 'one');
    mkdirSync(join(dir, 'folder', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'folder', 'entry.mjs'), 'entry');
    writeFileSync(join(dir, 'folder', 'nested', 'lib.ts'), 'lib');
    const one = readCandidate([join(dir, 'single.txt')]);
    assert.equal(one.mode, 'file');
    assert.deepEqual([...one.files.keys()], ['single.txt']);
    const folder = readCandidate([join(dir, 'folder')]);
    assert.equal(folder.mode, 'folder');
    assert.deepEqual([...folder.files.keys()], ['entry.mjs', 'nested/lib.ts']);
    // several files are a folder too, named by their own names
    const several = readCandidate([join(dir, 'single.txt'), join(dir, 'folder', 'entry.mjs')]);
    assert.equal(several.mode, 'folder');
    assert.deepEqual([...several.files.keys()].sort(), ['entry.mjs', 'single.txt']);
    // the same name twice, a missing path and a link are refused
    assert.throws(() => readCandidate([join(dir, 'folder', 'entry.mjs'), join(dir, 'folder')]), ReplayError);
    assert.throws(() => readCandidate([join(dir, 'missing')]));
    symlinkSync(join(dir, 'single.txt'), join(dir, 'folder', 'link.txt'));
    assert.throws(() => readCandidate([join(dir, 'folder')]), ReplayError);
    assert.throws(() => readCandidate([join(dir, 'folder', 'link.txt')]), ReplayError);
    assert.throws(() => readCandidate([]), ReplayError);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The port above is checked against the candidate Circle's own build when one is given: the same exit code, output and error
// text go through its `interpretHookRun` and `combineOutcomes`, and the decision and reason must be the same.
const circle = process.env.CIRCLE_HUB_REPLAY_CIRCLE_CANDIDATE;
test('the reading of a hook answer is the candidate Circle\'s own reading', { skip: circle === undefined ? '需要 CIRCLE_HUB_REPLAY_CIRCLE_CANDIDATE 指向候选 Circle（1.18.0-local.2）的目录' : false }, async () => {
  const { interpretHookRun, combineOutcomes } = await import(pathToFileURL(join(circle!, 'dist', 'hooks.js')).href);
  const outputs = [
    '', '   ', 'plain text', 'plain {with braces}', '{}', '{"a":1}', '{', '{"hookSpecificOutput":', '[]', 'null', '{} trailing',
    allow, deny('why'), deny(), deny(''), deny('  padded  '),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sure?' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'maybe' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } }),
    JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'x' } } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: 'x' } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 1 } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', additionalContext: 5 } }),
    JSON.stringify({ decision: 'block', reason: 'old' }), JSON.stringify({ decision: 'deny' }), JSON.stringify({ decision: 'approve' }), JSON.stringify({ decision: 'allow', reason: 'fine' }),
    JSON.stringify({ decision: 'ask', reason: 'q' }), JSON.stringify({ decision: 'nope' }), JSON.stringify({ decision: 3 }),
    JSON.stringify({ decision: 'block', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }),
    JSON.stringify({ continue: false, stopReason: 'halt' }), JSON.stringify({ continue: 'no' }), JSON.stringify({ systemMessage: 'hello' }), JSON.stringify({ systemMessage: 4 }),
    JSON.stringify({ suppressOutput: 'x' }), JSON.stringify({ updated_input: { a: 1 } }), JSON.stringify({ updated_input: 'a' }), JSON.stringify({ context: 'c' }), JSON.stringify({ context: 1 }), JSON.stringify({ user_message: 'm' }),
  ];
  const stderrs = ['', 'oops', '  trimmed  \nsecond'];
  let compared = 0;
  for (const onFailure of ['block', 'continue', undefined] as const)
    for (const exitCode of [0, 1, 2, 3, null])
      for (const stdout of outputs)
        for (const stderr of stderrs) {
          const hook = { id: 'h', event: 'PreToolUse', name: 'guard', command: 'node', ...(onFailure ? { onFailure } : {}) };
          const result = { stdout, stderr, exitCode, timedOut: false };
          const outcome = { hook, exitCode, timedOut: false, stdout, stderr, durationMs: 0, ...interpretHookRun(hook, 'PreToolUse', result, false) };
          const batch = combineOutcomes('PreToolUse', [outcome], { command: 'original' }, {}, 'execute');
          const mine = interpretCircle118({ name: 'guard', ...(onFailure ? { onFailure } : {}) })(exitCode, stdout, stderr);
          const label = JSON.stringify({ onFailure, exitCode, stdout, stderr });
          assert.equal(mine.decision, batch.decision, label);
          assert.equal(mine.reason, batch.reason, label);
          assert.equal(mine.failed, outcome.failed, label);
          assert.equal(Boolean(mine.rewritten), batch.updatedInput !== undefined, label);
          compared++;
        }
  assert.equal(compared, 3 * 5 * outputs.length * stderrs.length);
});
