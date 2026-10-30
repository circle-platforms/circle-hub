import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recReference } from '../refs/api.ts';
import { DECLARATION_GROUND, declarationGroundsRefusal } from './declaration-grade.ts';

const operation = 'a'.repeat(64);
const command = 'b'.repeat(64);
const records = new Map<string, {body: unknown}>([
  [operation, {body: {statement: {data: {feeding: {schema: 'fed-observation@1'}}}}}],
  [command, {body: {statement: {data: {feeding: {schema: 'fed-command@1'}}}}}],
]);
const read = async (digest: string) => records.get(digest) ?? null;

test('a use as grounds is refused when the reference or a ground it carries is an operation record', async () => {
  assert.equal(await declarationGroundsRefusal({scheme: 'rec', record: operation}, undefined, read), DECLARATION_GROUND);
  assert.equal(await declarationGroundsRefusal({scheme: 'tree'}, [recReference(command), recReference(operation)], read), DECLARATION_GROUND);
  assert.equal(await declarationGroundsRefusal({scheme: 'rec', record: command}, [recReference(command), 'not a reference'], read), null);
});
