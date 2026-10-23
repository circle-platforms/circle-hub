import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubjectCopyError, createSubjectBuilder } from './subjects.ts';

const target = { packDir: '/synthetic-pack', module: 'functions/subject.ts' };

test('identical in-flight subject inputs share construction and return byte-identical isolated values', async () => {
  let calls = 0;
  const output = { items: [{ text: '合成值', number: 0, list: [null, true, 3] }] };
  const build = createSubjectBuilder(async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return output; });
  const [first, second] = await Promise.all([build(target, { item: 'one' }), build(target, { item: 'one' })]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(output));
  assert.equal(JSON.stringify(second), JSON.stringify(output));
  assert.deepEqual(first, output); assert.deepEqual(second, output);
  assert.notEqual(first, second);
  (first as typeof output).items[0].text = 'changed';
  assert.deepEqual(second, output);
  assert.deepEqual(await build(target, { item: 'one' }), output);
});

test('input bytes, function module, export and pack identity cannot share construction', async () => {
  let calls = 0;
  const build = createSubjectBuilder(async (_target, input) => { calls++; return input; });
  await build(target, { item: 'one' });
  await build({ ...target, export: 'default' }, { item: 'one' });
  assert.equal(calls, 1, 'implicit and explicit default name the same function');
  for (const [entry, input] of [
    [target, { item: 'two' }],
    [{ ...target, module: 'functions/other.ts' }, { item: 'one' }],
    [{ ...target, export: 'other' }, { item: 'one' }],
    [{ ...target, packDir: '/synthetic-other-version' }, { item: 'one' }],
    [target, { item: 'one', slots: { value: 1 } }],
  ] as const) assert.deepEqual(await build(entry, input), input);
  assert.equal(calls, 6);
});

test('a new submission or item scope always reconstructs even with identical input bytes', async () => {
  let calls = 0;
  const execute = async () => ({ count: ++calls });
  const first = createSubjectBuilder(execute);
  const second = createSubjectBuilder(execute);
  assert.deepEqual(await first(target, {}), { count: 1 });
  assert.deepEqual(await second(target, {}), { count: 2 });
});

test('failed construction is retried and the original failure is preserved', async () => {
  let calls = 0; const failure = new Error('synthetic transient failure');
  const build = createSubjectBuilder(async () => { if (++calls === 1) throw failure; return { recovered: true }; });
  await assert.rejects(build(target, {}), error => error === failure);
  assert.deepEqual(await build(target, {}), { recovered: true });
  assert.equal(calls, 2);
});

test('the input digest describes the snapshot actually passed to the isolated function', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const build = createSubjectBuilder(async (_target, input) => { await wait; return input; });
  const input = { slots: { value: 'before' } };
  const first = build(target, input); input.slots.value = 'after'; release();
  assert.deepEqual(await first, { slots: { value: 'before' } });
  assert.deepEqual(await build(target, input), input);
});

test('non-JSON input keeps the executor refusal without caching or changing its identity', async () => {
  const failure = new Error('synthetic invalid input'); let calls = 0;
  const build = createSubjectBuilder(async () => { calls++; throw failure; });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [undefined, cycle]) await assert.rejects(build(target, input), error => error === failure);
  assert.equal(calls, 2);
});

test('a 4000-level subject is parsed independently for every check without rebuilding', async () => {
  const wire = '{"next":'.repeat(4000) + '7' + '}'.repeat(4000);
  let calls = 0;
  const build = createSubjectBuilder(async () => { calls++; return JSON.parse(wire); });
  const first = await build(target, {}); const second = await build(target, {});
  assert.equal(JSON.stringify(first), wire); assert.equal(JSON.stringify(second), wire);
  assert.notEqual(first, second); assert.equal(calls, 1);
});

test('a Hub parse failure retains the successful build and retries only its copy', async () => {
  const output = { deep: { value: 7 } }; const wire = JSON.stringify(output);
  const parse = JSON.parse; let calls = 0; let fail = true;
  const build = createSubjectBuilder(async () => { calls++; return output; });
  try {
    JSON.parse = ((text: string, ...args: unknown[]) => {
      if (text === wire && fail) { fail = false; throw new RangeError('synthetic host copy failure'); }
      return Reflect.apply(parse, JSON, [text, ...args]);
    }) as typeof JSON.parse;
    await assert.rejects(build(target, {}), error => error instanceof SubjectCopyError);
    assert.deepEqual(await build(target, {}), output); assert.equal(calls, 1);
  } finally { JSON.parse = parse; }
});
