import assert from 'node:assert/strict';
import test from 'node:test';
import { circleEntry } from './context.ts';

test('circleEntry matches Circle mcpServers map and placeholders', () => {
  const parsed = JSON.parse(circleEntry('https://192.0.2.10:7421', false));
  assert.deepEqual(Object.keys(parsed.mcpServers), ['Hub']);
  const entry = parsed.mcpServers.Hub;
  assert.equal(entry.type, 'http');
  assert.equal(entry.url, 'https://192.0.2.10:7421/mcp');
  assert.deepEqual(entry.placeholders, { url: 'HUB_URL', token: 'HUB_TOKEN' });
  assert.equal(entry.headers, undefined);
});

test('token form keeps Hub server key and placeholders with the secret header', () => {
  const entry = JSON.parse(circleEntry('http://192.0.2.10:7420', true)).mcpServers.Hub;
  assert.equal(entry.type, 'http');
  assert.deepEqual(entry.placeholders, { url: 'HUB_URL', token: 'HUB_TOKEN' });
  assert.equal(entry.headers.Authorization, 'Bearer ${secret:CIRCLE_HUB_TOKEN}');
});
