import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database, Row } from './db.ts';
import type { Transaction } from './api.ts';
import { readMigrationCompatibility, appendMigrationCompatibility } from './migration-compatibility-store.ts';
import { evaluateMigrationCompatibility, type MigrationCompatibilityDeclaration } from './migration-compatibility.ts';

const baseline = { version: 1, name: 'baseline', sha256: 'a'.repeat(64) };
const next = { version: 2, name: 'synthetic_addition', sha256: 'b'.repeat(64) };
const declaration: MigrationCompatibilityDeclaration = { migration_version: 2, format_version: 1, migration_name: next.name, migration_sha256: next.sha256, minimum_reader_level: 2 };
const tx: Transaction = { transactionId: 73 };
type Step = { sql: string; rows?: Row[]; values?: readonly unknown[]; fail?: Error };
function script(steps: Step[]) {
  const calls: string[] = [];
  const db: Pick<Database, 'query'> = {
    async query<R extends Row>(sql: string, values: readonly unknown[] = [], transaction?: Transaction) {
      calls.push(sql);
      assert.equal(transaction, tx);
      const step = steps.shift(); assert.ok(step, `unexpected SQL: ${sql}`);
      assert.ok(sql.includes(step.sql), `expected ${step.sql}: ${sql}`);
      if (step.values) assert.deepEqual(values, step.values);
      if (step.fail) throw step.fail;
      const rows = (step.rows ?? []) as R[];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  };
  return { db, calls, done: () => assert.equal(steps.length, 0) };
}
const discovery = { migration_table: 'schema_migrations', declaration_table: 'hub_migration_compatibility', declarations_read_only: true };
const begin = (): Step => ({ sql: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' });
const owner = (): Step => ({ sql: 'AS owns', rows: [{ owns: true }] });
const locked = (): Step => ({ sql: 'LOCK TABLE public.hub_migration_compatibility IN SHARE ROW EXCLUSIVE MODE' });
const receipts = (): Step => ({ sql: 'FROM public.schema_migrations', rows: [baseline, next] });
const declarations = (rows: Row[] = []): Step => ({ sql: 'FROM public.hub_migration_compatibility ORDER BY migration_version', rows });

test('read discovers only public carriers in a read-only snapshot and preserves exact columns', async () => {
  const f = script([begin(), { sql: 'to_regclass', rows: [discovery] }, receipts(), declarations([{ ...declaration }])]);
  const observation = await readMigrationCompatibility(f.db, tx); f.done();
  assert.deepEqual(observation, { available: true, applied: [baseline, next], declarations: [declaration], declarationsReadOnly: true });
  assert.equal(evaluateMigrationCompatibility([baseline], observation, 2).compatible, true);
  assert.ok(f.calls[1].includes('public.hub_migration_compatibility'));
  assert.ok(f.calls[1].includes('has_any_column_privilege'));
  assert.ok(f.calls.every(sql => !/\b(INSERT|UPDATE|DELETE|CREATE)\s+(INTO|TABLE|FROM)\b/.test(sql)));
});

test('absent carrier is strict, while an absent migration journal is an observed incompatibility', async () => {
  const missingCarrier = script([begin(), { sql: 'to_regclass', rows: [{ ...discovery, declaration_table: null, declarations_read_only: null }] }, { sql: 'FROM public.schema_migrations', rows: [baseline] }]);
  const state = await readMigrationCompatibility(missingCarrier.db, tx); missingCarrier.done();
  assert.equal(evaluateMigrationCompatibility([baseline], state, 1).compatible, true);
  const missingJournal = script([begin(), { sql: 'to_regclass', rows: [{ migration_table: null, declaration_table: null, declarations_read_only: null }] }]);
  const absent = await readMigrationCompatibility(missingJournal.db, tx); missingJournal.done();
  assert.equal(absent.available, true); assert.equal(absent.applied, null);
  assert.equal(evaluateMigrationCompatibility([baseline], absent, 1).status, 'incompatible');
});

test('query failures are unavailable and never disclose raw connection or permission errors', async () => {
  for (const failingStep of [0, 1, 2, 3]) {
    const steps: Step[] = [begin(), { sql: 'to_regclass', rows: [discovery] }, receipts(), declarations()];
    steps[failingStep].fail = new Error('SYNTHETIC_PRIVATE_ERROR');
    const f = script(steps.slice(0, failingStep + 1));
    const observation = await readMigrationCompatibility(f.db, tx); f.done();
    assert.equal(observation.available, false); assert.equal(observation.applied, null);
    const result = evaluateMigrationCompatibility([baseline], observation, 2);
    assert.equal(result.status, 'unavailable'); assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_ERROR'), false);
  }
});

test('writable or owner-mismatched declarations never become compatibility authority', async () => {
  const f = script([begin(), { sql: 'to_regclass', rows: [{ ...discovery, declarations_read_only: false }] }, receipts(), declarations([{ ...declaration }])]);
  const result = evaluateMigrationCompatibility([baseline], await readMigrationCompatibility(f.db, tx), 2); f.done();
  assert.equal(result.status, 'incompatible');
});

test('append uses only the caller transaction, exact existing columns, and a verified receipt', async () => {
  const f = script([owner(), locked(), receipts(), declarations(), {
    sql: 'INSERT INTO public.hub_migration_compatibility(migration_version,format_version,migration_name,migration_sha256,minimum_reader_level)',
    values: [2, 1, next.name, next.sha256, 2],
  }]);
  await appendMigrationCompatibility(f.db, tx, declaration); f.done();
  assert.ok(f.calls.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/.test(sql)));
});

test('append is idempotent only for identical immutable declarations', async () => {
  const f = script([owner(), locked(), receipts(), declarations([{ ...declaration }])]);
  await appendMigrationCompatibility(f.db, tx, declaration); f.done();
  assert.equal(f.calls.some(sql => sql.includes('INSERT INTO')), false);
  const conflict = script([owner(), locked(), receipts(), declarations([{ ...declaration, minimum_reader_level: 3 }])]);
  await assert.rejects(appendMigrationCompatibility(conflict.db, tx, declaration), /不能修改/); conflict.done();
});

test('non-owner, wrong receipt, missing predecessor declaration and lower floor reject before insert', async () => {
  const denied = script([{ sql: 'AS owns', rows: [{ owns: false }] }]);
  await assert.rejects(appendMigrationCompatibility(denied.db, tx, declaration), /拥有者/); denied.done();
  const wrong = script([owner(), locked(), receipts(), declarations()]);
  await assert.rejects(appendMigrationCompatibility(wrong.db, tx, { ...declaration, migration_sha256: 'c'.repeat(64) }), /回执/); wrong.done();
  const third = { version: 3, name: 'synthetic_third', sha256: 'd'.repeat(64) };
  const thirdDeclaration = { ...declaration, migration_version: 3, migration_name: third.name, migration_sha256: third.sha256 };
  for (const prior of [[], [{ ...declaration, minimum_reader_level: 3 }]]) {
    const f = script([owner(), locked(), { sql: 'FROM public.schema_migrations', rows: [baseline, next, third] }, declarations(prior)]);
    await assert.rejects(appendMigrationCompatibility(f.db, tx, thirdDeclaration), /声明|级别/); f.done();
  }
});

test('append SQL failure propagates for the caller to roll back, without a second commit', async () => {
  const failure = new Error('synthetic insert failure');
  const f = script([owner(), locked(), receipts(), declarations(), { sql: 'INSERT INTO', fail: failure }]);
  await assert.rejects(appendMigrationCompatibility(f.db, tx, declaration), error => error === failure); f.done();
  assert.ok(!f.calls.some(sql => sql === 'COMMIT'));
});
