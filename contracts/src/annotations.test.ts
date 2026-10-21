// (c) annotationsFor reproduces the D06 table for the six tools exactly, and the D03 R[6] rules beyond milestone 1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECT_CLASS } from '../generated/vocabulary.ts';
import { annotationsFor } from './annotations.ts';
import { TOOLS } from './tools.ts';

/** D06 F[0]-F[5]. start_run has two rows: closed-world, and open-world when the caller's packs read an external system to pick a build. */
const D06 = {
  list_task_packs: { readOnlyHint: true, openWorldHint: false },
  upload_file: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  start_run: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  start_run_reading_external: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  get_nodes: { readOnlyHint: true, openWorldHint: false },
  resolve_reference: { readOnlyHint: true, openWorldHint: false },
  submit_result: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

test('each of the six tools is annotated exactly as the D06 table says', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result'] as const) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is defined`);
    assert.equal(tool.effect, 'none', `${name} has effect class none (D06)`);
    assert.deepEqual(annotationsFor(tool.effect, tool.writesHubRecords, { idempotent: tool.idempotent }), D06[name], `${name} for a caller whose packs read nothing outside`);
  }
  const startRun = byName.get('start_run');
  assert.ok(startRun?.readsExternal, 'start_run reads an external system for some packs');
  assert.deepEqual(annotationsFor(startRun.effect, startRun.writesHubRecords, { readsExternal: true, idempotent: startRun.idempotent }), D06.start_run_reading_external);
  assert.equal(startRun.idempotent, undefined, 'start_run keys have a window, so no idempotentHint (D03 R[6])');
});

test('which tools write Hub records follows D06', () => {
  const writes = Object.fromEntries(TOOLS.map((t) => [t.name, t.writesHubRecords]));
  assert.deepEqual(writes, { list_task_packs: false, upload_file: true, start_run: true, get_nodes: false, resolve_reference: false, submit_result: true });
});

test('D03 R[6] beyond the six tools: external reads and writes', () => {
  // An external read is read-only only when the transport enforces it and that is certified; otherwise it is annotated as a write.
  assert.deepEqual(annotationsFor('read', false, { readOnlyEnforced: true }), { readOnlyHint: true, openWorldHint: true });
  assert.deepEqual(annotationsFor('read', true, { readOnlyEnforced: true }), { readOnlyHint: true, openWorldHint: true });
  assert.deepEqual(annotationsFor('read', false), { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  // External writes are open-world; destructive unless reversible; idempotent only when declared (same-key safe, certified).
  for (const effect of ['sync_write', 'job', 'notification'] as const) {
    assert.deepEqual(annotationsFor(effect, true), { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    assert.deepEqual(annotationsFor(effect, false, { reversible: true }), { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    assert.deepEqual(annotationsFor(effect, true, { reversible: true, idempotent: true }), {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: true,
    });
  }
  // D06 R[4]: submit_result that may make the Hub dispatch a job takes the widest dispatched row and stays idempotent.
  assert.deepEqual(annotationsFor('job', true, { idempotent: true }), { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true });
  // Read-only tools never carry destructiveHint or idempotentHint.
  assert.deepEqual(annotationsFor('none', false, { idempotent: true }), { readOnlyHint: true, openWorldHint: false });
});

test('an effect class the table does not know gets the most conservative hints, whatever the options say', () => {
  // A value added to the effect_class axis before annotations.ts places it: no client may auto-approve such a tool.
  const conservative = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  for (const unknown of ['stream_write', 'constructor', 'toString', '']) {
    assert.deepEqual(annotationsFor(unknown as never, true, { idempotent: true, reversible: true, readOnlyEnforced: true }), conservative, unknown);
    assert.deepEqual(annotationsFor(unknown as never, false), conservative, unknown);
  }
});

test('every effect class of the vocabulary is placed, so none falls to the conservative default', () => {
  const conservative = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  for (const effect of EFFECT_CLASS) {
    const placed = effect === 'read' ? annotationsFor(effect, false, { readOnlyEnforced: true }) : annotationsFor(effect, false, { reversible: true });
    assert.notDeepEqual(placed, conservative, effect);
  }
});
