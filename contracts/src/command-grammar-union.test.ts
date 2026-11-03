// Command identity of a line whose optional argument has a union type: the catalog publishes one signature per alternative under
// the same declared reference, and the line binds positionally as the declared signature does. Synthetic tree and addresses only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandIdentity, compileGrammar } from './command-grammar.ts';
import type { CatalogSignature } from './tables.ts';

const ROOT = 'c'.repeat(64);
const reference = (item: number) => `src:${ROOT}/xml@1/x/commands/scope/menu[1]/item[${item}]/arguments`;
const param = (name: string, type: 'string' | 'ipv4' | 'ipv6', optional = false) => ({
  name, type, native_type: { name: type === 'string' ? 'STRING' : 'IPADDR', grammar: 'synthetic-tree@1' }, ...(optional ? { optional: true, default: '' } : {}),
});
/** The name, then two address positions whose IPADDR type is published as IPv4 and IPv6 alternatives. */
function expansions(item: number, required: boolean): CatalogSignature[] {
  const out: CatalogSignature[] = [];
  for (const start of ['ipv4', 'ipv6'] as const) for (const end of ['ipv4', 'ipv6'] as const) out.push({ id: `${item}.${out.length + 1}`, reference: reference(item), params: [param('name', 'string'), param('start', start, !required), param('end', end, true)] } as CatalogSignature);
  return out;
}
const grammar = (words: string[], signatures: CatalogSignature[], more: CatalogSignature[] = []) => {
  const value = compileGrammar([{ path: '/commands/' + words.join('/'), words, signatures: [...signatures, ...more] }]);
  value.tree_root = ROOT;
  return value;
};
const bound = (line: string, words: string[], signatures: CatalogSignature[], more: CatalogSignature[] = []) =>
  commandIdentity(grammar(words, signatures, more), line)?.parameters.map((value) => `${value.position}:${value.name}:${value.type.catalog_type}`) ?? null;

test('an omitted optional union argument does not move a given address to the next position', () => {
  const words = ['no', 'widget', 'pool'];
  assert.deepEqual(bound('no widget pool p1 192.0.2.70', words, expansions(1, false)), ['0:name:string', '1:start:ipv4']);
  assert.deepEqual(bound('no widget pool p1 192.0.2.70 192.0.2.71', words, expansions(1, false)), ['0:name:string', '1:start:ipv4', '2:end:ipv4']);
  assert.deepEqual(bound('no widget pool p1 2001:db8::70', words, expansions(1, false)), ['0:name:string', '1:start:ipv6']);
  assert.deepEqual(bound('no widget pool p1', words, expansions(1, false)), ['0:name:string']);
});

test('a required union position and the full lines keep the identity they had', () => {
  const words = ['widget', 'pool'];
  assert.deepEqual(bound('widget pool p1 192.0.2.70', words, expansions(1, true)), ['0:name:string', '1:start:ipv4']);
  assert.deepEqual(bound('widget pool p1 192.0.2.70 2001:db8::71', words, expansions(1, true)), ['0:name:string', '1:start:ipv4', '2:end:ipv6']);
});

test('two declared signatures that both take the line still leave it without a unique identity', () => {
  const words = ['no', 'widget', 'pool'];
  assert.equal(bound('no widget pool p1 192.0.2.70', words, expansions(1, false), expansions(2, false)), null);
});
