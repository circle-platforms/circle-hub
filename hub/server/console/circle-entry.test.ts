import assert from 'node:assert/strict';
import test from 'node:test';
import { circleEntry } from './context.ts';

test('circleEntry matches Circle /hub name and placeholders', () => {
  const parsed = JSON.parse(circleEntry('https://192.0.2.10:7421', false));
  assert.equal(parsed.mcp_servers.length, 1);
  const entry = parsed.mcp_servers[0];
  assert.equal(entry.name, 'Hub');
  assert.equal(entry.url, 'https://192.0.2.10:7421/mcp');
  assert.equal(entry.transport, 'streamable_http');
  assert.deepEqual(entry.placeholders, { url: 'HUB_URL', token: 'HUB_TOKEN' });
  assert.equal(entry.headers, undefined);
});

test('token form keeps Hub name and placeholders with the secret header', () => {
  const entry = JSON.parse(circleEntry('http://192.0.2.10:7420', true)).mcp_servers[0];
  assert.equal(entry.name, 'Hub');
  assert.deepEqual(entry.placeholders, { url: 'HUB_URL', token: 'HUB_TOKEN' });
  assert.equal(entry.headers.Authorization, 'Bearer ${secret:CIRCLE_HUB_TOKEN}');
});
