import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksOf, createScriptedModel, streamOf, turnOf, type Respond } from './scripted-model.ts';

const parseSse = (text: string) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const [event, data] = chunk.split('\n');
      return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) };
    });

test('a turn counts the assistant replies and extracts the last tool results as text', () => {
  const turn = turnOf({
    system: 'S',
    tools: [{ name: 'hub_echo' }],
    messages: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'hub_echo', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'echo: ping' }] }, { type: 'tool_result', tool_use_id: 't2', content: 'plain', is_error: true }] },
    ],
  });
  assert.equal(turn.index, 1);
  assert.deepEqual(turn.toolResults, [
    { id: 't1', text: 'echo: ping', isError: false },
    { id: 't2', text: 'plain', isError: true },
  ]);
  assert.deepEqual(turnOf({ messages: [{ role: 'user', content: 'hi' }] }).toolResults, []);
});

test('the stream has the Anthropic event order, text before tool use, and stop reason tool_use', () => {
  const events = parseSse(streamOf(blocksOf([{ text: '好的' }, { tool: 'hub_echo', input: { text: 'ping' } }]), 'm'));
  assert.deepEqual(
    events.map((e) => e.event),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  );
  assert.equal(events[2].data.delta.text, '好的');
  assert.equal(events[4].data.content_block.name, 'hub_echo');
  assert.deepEqual(JSON.parse(events[5].data.delta.partial_json), { text: 'ping' });
  assert.equal(events[7].data.delta.stop_reason, 'tool_use');
  assert.equal(parseSse(streamOf(blocksOf([{ text: 'x' }]), 'm')).at(-2)?.data.delta.stop_reason, 'end_turn');
});

test('the server answers streaming and plain requests with the scripted reply and logs what it was shown', async () => {
  const seen: string[] = [];
  const respond: Respond = (turn) => {
    seen.push(turn.toolResults.map((r) => r.text).join('|') || '(none)');
    return turn.index === 0 ? [{ tool: 'hub_echo', input: { text: 'ping' } }] : [{ text: '完成' }];
  };
  const server = createScriptedModel({ respond, model: 'scripted-x' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const call = async (body: unknown) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await (await call({ model: 'm', stream: false, messages: [{ role: 'user', content: 'go' }] })).json();
    assert.equal(first.stop_reason, 'tool_use');
    assert.equal(first.content[0].name, 'hub_echo');
    const second = await (
      await call({
        model: 'm',
        stream: true,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [first.content[0]] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: 'echo: ping' }] },
        ],
      })
    ).text();
    assert.match(second, /完成/);
    assert.deepEqual(seen, ['(none)', 'echo: ping']);
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    assert.equal(models.data[0].id, 'scripted-x');
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
