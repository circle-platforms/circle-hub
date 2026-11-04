// The trace context without a database: no-ops outside a trace, the step tree and its usage, traces that run at once, what
// is known late, steps that outlive their root, the bound on one trace, and the statement of a slow query.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createSlotPool } from '../rules/sandbox/slots.ts';
import { stagingSlots } from '../records/staging-slots.ts';
import {
  MAX_TRACE_STEPS,
  SLOW_QUERY_MS,
  addEvent,
  addUsage,
  background,
  currentTrace,
  installTraceSink,
  recordQuery,
  recordSourceRead,
  setTraceStatus,
  startTrace,
  step,
  tracing,
  updateTrace,
  withoutTrace,
  type SpanRow,
} from './usage.ts';

let uninstall = (): void => {};
afterEach(() => uninstall());

function collect(): SpanRow[] {
  const rows: SpanRow[] = [];
  uninstall = installTraceSink({ push: (row) => rows.push(row) });
  return rows;
}

const named = (rows: readonly SpanRow[], name: string): SpanRow => {
  const row = rows.find((candidate) => candidate.name === name);
  assert.ok(row, `a row named ${name}`);
  return row;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('outside a trace every call only does what it was given', async () => {
  assert.equal(tracing(), false);
  assert.equal(currentTrace(), null);
  addUsage('db.rows', 5);
  recordQuery('SELECT 1', [{ a: 'x' }], 1, 0);
  recordSourceRead(1, 1);
  addEvent('slow-query', 'warning', 'nothing');
  updateTrace({ userId: 'usr_x' });
  setTraceStatus('error', 'nothing');
  assert.equal(step('read-source', () => 7), 7);
  assert.equal(await step('read-source', async () => 8), 8);
  assert.throws(() => step('read-source', () => { throw new RangeError('passes through'); }), RangeError);
  await assert.rejects(step('read-source', async () => { throw new RangeError('passes through'); }), RangeError);
  assert.equal(startTrace({ name: 'maintain-runs', origin: 'background' }, () => 9), 9, 'without a sink a trace only runs its work');
  assert.equal(background('maintain-runs', () => tracing()), false);
});

test('steps nest with their parents; a parent counts its children and self.ms is what the listed usage leaves', async () => {
  const rows = collect();
  await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => {
    addUsage('db.rows', 1);
    await step('read-source', async () => {
      addUsage('db.rows', 2);
      await step('parse-document', async () => {
        addUsage('db.rows', 4);
        addUsage('db.ms', 0.25);
      });
    }, { type: 'retriever' });
    step('append-record', () => addUsage('db.rows', 8));
  });
  assert.deepEqual(rows.map((row) => row.name).sort(), ['append-record', 'get_nodes', 'parse-document', 'read-source']);
  const root = named(rows, 'get_nodes'), read = named(rows, 'read-source'), parse = named(rows, 'parse-document'), append = named(rows, 'append-record');
  assert.equal(root.is_root, true);
  assert.equal(root.parent_span_id, null);
  assert.equal(read.parent_span_id, root.span_id);
  assert.equal(parse.parent_span_id, read.span_id);
  assert.equal(append.parent_span_id, root.span_id, 'a sibling hangs under the step around it, not under the one before it');
  assert.ok(rows.every((row) => row.trace_id === root.trace_id && /^[0-9a-f]{32}$/.test(row.trace_id) && /^[0-9a-f]{16}$/.test(row.span_id)));
  assert.equal(read.type, 'retriever');
  assert.equal(append.type, 'span');
  assert.equal(parse.usage['db.rows'], 4);
  assert.equal(read.usage['db.rows'], 6);
  assert.equal(root.usage['db.rows'], 15);
  assert.equal(root.usage['db.ms'], 0.25);
  assert.ok((root.usage['self.ms'] ?? -1) >= 0 && rows.every((row) => typeof row.usage['self.ms'] === 'number'));
});

test('self.ms never goes below zero when the measured time exceeds the step (work that ran side by side)', () => {
  const rows = collect();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => addUsage('db.ms', 1e9));
  assert.equal(rows[0].usage['self.ms'], 0);
});

test('a failure stays the failure of the code, and its step says so with a code or a fixed sentence', async () => {
  const rows = collect();
  const coded = Object.assign(new Error('secret text of the message'), { code: 'SOURCE_ABSENT' });
  await assert.rejects(startTrace({ name: 'get_nodes', origin: 'mcp' }, () => step('read-source', async () => { throw coded; })), (error) => error === coded);
  assert.equal(named(rows, 'read-source').level, 'error');
  assert.equal(named(rows, 'read-source').status_message, 'SOURCE_ABSENT');
  assert.equal(named(rows, 'get_nodes').level, 'error', 'the failure passed through the root');
  rows.length = 0;
  const plain = new Error('quoted business text');
  assert.throws(() => startTrace({ name: 'get_nodes', origin: 'mcp' }, () => step('parse-document', () => { throw plain; })), (error) => error === plain);
  assert.equal(named(rows, 'parse-document').status_message, '步骤出错');
  assert.ok(!JSON.stringify(rows).includes('quoted business text'));
});

test('traces running at once keep their usage apart', async () => {
  const rows = collect();
  const run = (name: 'get_nodes' | 'start_run', value: number) => startTrace({ name, origin: 'mcp' }, async () => {
    for (let round = 0; round < 50; round++) {
      addUsage('db.rows', value);
      await tick();
      await step('read-source', async () => {
        addUsage('source.bytes', value);
        await tick();
      });
    }
  });
  await Promise.all([run('get_nodes', 1), run('start_run', 100)]);
  const roots = rows.filter((row) => row.is_root);
  assert.equal(roots.length, 2);
  assert.notEqual(roots[0].trace_id, roots[1].trace_id);
  assert.equal(named(roots, 'get_nodes').usage['db.rows'], 50);
  assert.equal(named(roots, 'start_run').usage['db.rows'], 5000);
  assert.equal(named(roots, 'get_nodes').usage['source.bytes'], 50);
  assert.equal(named(roots, 'start_run').usage['source.bytes'], 5000);
});

test('a task that waited for a slot runs in the trace that asked, not in the one that freed the slot', async () => {
  const rows = collect();
  const pool = createSlotPool({ running: 1, waiting: 10, full: () => new Error('full') });
  let release = (): void => {};
  const first = startTrace({ name: 'get_nodes', origin: 'mcp' }, () => pool.run(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    addUsage('sandbox.runs', 1);
  }));
  const second = startTrace({ name: 'start_run', origin: 'mcp' }, () => pool.run(async () => {
    addUsage('sandbox.runs', 100);
  }));
  assert.equal(pool.queued, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(named(rows, 'get_nodes').usage['sandbox.runs'], 1);
  assert.equal(named(rows, 'start_run').usage['sandbox.runs'], 100);
});

test('staged work that waited its turn runs in the trace that asked for it', async () => {
  const rows = collect();
  const slots = stagingSlots(1);
  let release = (): void => {};
  const first = startTrace({ name: 'get_nodes', origin: 'mcp' }, () => slots('owner-a', async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    addUsage('db.rows', 1);
  }));
  const second = startTrace({ name: 'start_run', origin: 'mcp' }, () => slots('owner-b', async () => addUsage('db.rows', 100)));
  release();
  await Promise.all([first, second]);
  assert.equal(named(rows, 'get_nodes').usage['db.rows'], 1);
  assert.equal(named(rows, 'start_run').usage['db.rows'], 100);
});

test('what is known late reaches every row of the trace, the steps that ended before it included', () => {
  const rows = collect();
  startTrace({ name: 'handle-mcp', origin: 'mcp' }, () => {
    step('authenticate', () => {});
    updateTrace({
      name: 'submit_result', traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16), userId: 'usr_late', sessionId: 'session-1', runId: 'run_late',
      clientName: 'synthetic client', clientVersion: '1.2.3', clientPlatform: 'synthetic-os',
    });
  });
  const root = named(rows, 'submit_result');
  assert.equal(root.parent_span_id, 'b'.repeat(16), "a root's parent is the client's span");
  assert.equal(root.is_root, true);
  for (const row of rows) {
    assert.equal(row.trace_id, 'a'.repeat(32));
    assert.deepEqual([row.user_id, row.session_id, row.run_id, row.client_name, row.client_version, row.client_platform], ['usr_late', 'session-1', 'run_late', 'synthetic client', '1.2.3', 'synthetic-os']);
  }
  assert.equal(named(rows, 'authenticate').parent_span_id, root.span_id);
});

test('the first status mark stays and a lone surrogate or NUL never reaches a row', () => {
  const rows = collect();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => {
    setTraceStatus('error', 'SOURCE_ABSENT');
    setTraceStatus('warning', 'HTTP 404');
    updateTrace({ clientName: 'bad\ud800name\0', clientPlatform: 'bad\ud800os\0' });
  });
  assert.equal(rows[0].level, 'error');
  assert.equal(rows[0].status_message, 'SOURCE_ABSENT');
  assert.equal(rows[0].client_name, 'bad�name');
  assert.equal(rows[0].client_platform, 'bad�os');
});

test('a step that outlives its root is still written, and usage after the end goes to what is still open or nowhere', async () => {
  const rows = collect();
  let finishLate = (): void => {};
  let late: Promise<void> = Promise.resolve();
  startTrace({ name: 'serve-operations', origin: 'console' }, () => {
    late = step('run-pack', async () => {
      await new Promise<void>((resolve) => { finishLate = resolve; });
      addUsage('db.rows', 3);
    });
  });
  assert.deepEqual(rows.map((row) => row.name), ['serve-operations']);
  assert.equal(rows[0].usage['db.rows'], undefined);
  finishLate();
  await late;
  assert.deepEqual(rows.map((row) => row.name), ['serve-operations', 'run-pack']);
  assert.equal(rows[1].usage['db.rows'], 3);
  assert.equal(rows[1].trace_id, rows[0].trace_id);

  rows.length = 0;
  let outlived: Promise<void> = Promise.resolve();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => {
    outlived = Promise.resolve().then(async () => {
      await tick();
      assert.equal(tracing(), false, 'the trace ended: this work is not part of it any more');
      addUsage('db.rows', 1);
      assert.equal(step('read-source', () => 1), 1);
    });
  });
  await outlived;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage['db.rows'], undefined);
});

test('a background round is a trace of its own, whatever context its timer inherited', async () => {
  const rows = collect();
  let round: Promise<void> = Promise.resolve();
  startTrace({ name: 'serve-api', origin: 'console' }, () => {
    round = new Promise<void>((resolve) => setImmediate(() => {
      void background('poll-console', async () => addUsage('db.rows', 2)).then(resolve);
    }));
  });
  await round;
  const console = named(rows, 'serve-api'), poll = named(rows, 'poll-console');
  assert.notEqual(poll.trace_id, console.trace_id);
  assert.equal(poll.origin, 'background');
  assert.equal(poll.is_root, true);
  assert.equal(console.usage['db.rows'], undefined);
});

test('one trace keeps a bounded number of steps and says how many it left out; their usage still counts', () => {
  const rows = collect();
  startTrace({ name: 'maintain-runs', origin: 'background' }, () => {
    for (let index = 0; index < MAX_TRACE_STEPS + 5; index++) step('read-source', () => addUsage('db.rows', 1));
  });
  assert.equal(rows.length, MAX_TRACE_STEPS + 1);
  const root = named(rows, 'maintain-runs');
  assert.equal(root.usage['steps.dropped'], 5);
  assert.equal(root.usage['db.rows'], MAX_TRACE_STEPS + 5);
});

test('a sink that fails loses its rows and nothing else', async () => {
  uninstall = installTraceSink({ push: () => { throw new Error('sink failed'); } });
  assert.equal(await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => step('read-source', async () => 'answer')), 'answer');
});

test('withoutTrace leaves the trace; the root ids are readable inside one', () => {
  collect();
  startTrace({ name: 'get_nodes', origin: 'mcp', traceId: 'c'.repeat(32) }, () => {
    const inner = step('read-source', () => currentTrace());
    assert.equal(inner?.traceId, 'c'.repeat(32));
    assert.equal(inner?.rootSpanId, currentTrace()?.rootSpanId);
    assert.equal(withoutTrace(() => tracing()), false);
    assert.equal(tracing(), true);
  });
});

test('a query adds its usage: strings at the top of a row count, what pg parsed into objects is not walked', () => {
  const rows = collect();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => {
    recordQuery('SELECT body FROM records', [{ body: 'abcd', n: 7, parsed: { deep: 'x'.repeat(1000) } }, { body: 'ef', when: new Date(0) }], 2.5, 0.5);
    recordQuery('SELECT broken', undefined, 1, 0);
  });
  assert.equal(rows[0].usage['db.queries'], 2);
  assert.equal(rows[0].usage['db.rows'], 2);
  assert.equal(rows[0].usage['db.bytes'], 6);
  assert.equal(rows[0].usage['db.ms'], 3.5);
  assert.equal(rows[0].usage['db.wait_ms'], 0.5);
});

test('a source read adds its usage', () => {
  const rows = collect();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => recordSourceRead(1000, 2));
  assert.deepEqual([rows[0].usage['source.reads'], rows[0].usage['source.bytes'], rows[0].usage['source.ms']], [1, 1000, 2]);
});

test('a slow query is an event with its statement, never its parameters or a literal it holds', () => {
  const rows = collect();
  startTrace({ name: 'get_nodes', origin: 'mcp' }, () => step('read-source', () => {
    recordQuery(`SELECT *\n  FROM records WHERE kind = 'it''s private' AND id = $1`, [], SLOW_QUERY_MS + 500, 0);
    recordQuery('SELECT fast', [], SLOW_QUERY_MS - 1, 0);
  }));
  const events = rows.filter((row) => row.type === 'event');
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.name, 'slow-query');
  assert.equal(event.level, 'warning');
  assert.equal(event.status_message, `SELECT * FROM records WHERE kind = '?' AND id = $1`);
  assert.equal(event.parent_span_id, named(rows, 'read-source').span_id);
  assert.equal(Date.parse(event.ended_at) - Date.parse(event.started_at), SLOW_QUERY_MS + 500);
});
