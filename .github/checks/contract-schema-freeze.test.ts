import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SCHEMAS_DIR,
  compareJsonSchemas,
  contractSchemaFreezeViolations,
  reconcileSchemaFreeze,
  schemaFreezeExceptions,
  schemaFreezeProblems,
} from './contract-schema-freeze.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Synthetic Check', '-c', 'user.email=check@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

function writeSchema(root: string, name: string, schema: unknown): string {
  const rel = `${SCHEMAS_DIR}/${name}`;
  mkdirSync(join(root, SCHEMAS_DIR), { recursive: true });
  writeFileSync(join(root, rel), `${JSON.stringify(schema, null, 2)}\n`);
  return rel;
}

describe('contract schema freeze on the repository', () => {
  it('all published schemas under contracts/generated/schemas stay backward compatible against the release/* baseline', () => {
    assert.deepEqual(schemaFreezeProblems(ROOT), []);
  });

  it('catches the published v1 SkillParser regression if migration_test is removed', () => {
    const skillSchema = JSON.parse(readFileSync(join(ROOT, SCHEMAS_DIR, 'skill.v1.schema.json'), 'utf8')) as {
      properties: { parsers: { items: { properties: Record<string, unknown> } } };
    };
    const withoutMigrationTest = structuredClone(skillSchema);
    delete withoutMigrationTest.properties.parsers.items.properties.migration_test;
    const violations = compareJsonSchemas(skillSchema, withoutMigrationTest, 'skill.v1.schema.json');
    assert.deepEqual(
      violations.map((v) => [v.kind, v.path]),
      [['property-deleted', 'parsers[].migration_test']],
    );
  });
});

describe('approved breaks in the exception register', () => {
  const violation = { file: 'contracts/generated/schemas/a.v1.schema.json', path: 'x', kind: 'property-deleted' as const, detail: '删掉了已发布属性 x' };
  const entry = { check: 'contract-schema-freeze', path: violation.file, what: 'property-deleted: x', reason: 'synthetic', removeWhen: 'synthetic' };
  it('passes a listed break, fails an unlisted one, a stale entry and a duplicate', () => {
    const { entries, problems } = schemaFreezeExceptions([entry, { check: 'package-boundaries', path: 'p', what: 'w', reason: 'r', removeWhen: 'C4' }]);
    assert.deepEqual([entries.length, problems], [1, []]);
    assert.deepEqual(reconcileSchemaFreeze([violation], entries), []);
    assert.equal(reconcileSchemaFreeze([violation], []).length, 1);
    assert.match(reconcileSchemaFreeze([], entries)[0], /已不再发生/);
    assert.match(reconcileSchemaFreeze([violation], [...entries, ...entries]).join('\n'), /例外重复/);
    assert.match(schemaFreezeExceptions([{ check: 'contract-schema-freeze', path: violation.file }]).problems[0], /path、what、reason、removeWhen/);
  });
});

describe('git baseline resolution with release/* tags', () => {
  it('flags deleted key and optional->required while allowing added optional key and new schema files', () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-schema-freeze-'));
    try {
      gitIn(root, 'init', '-b', 'main');
      const v1Skill = {
        type: 'object',
        properties: {
          parsers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                migration_test: { type: 'string', minLength: 1, maxLength: 300 },
                parser: { type: 'string' },
                locate: { type: 'string' },
              },
              required: ['parser'],
              additionalProperties: false,
            },
          },
        },
        required: ['parsers'],
        additionalProperties: false,
      };
      const pathSkill = writeSchema(root, 'skill.v1.schema.json', v1Skill);
      gitIn(root, 'add', pathSkill);
      gitIn(root, 'commit', '-m', 'Baseline release schemas');
      gitIn(root, 'tag', '-a', 'release/2026-11-14', '-m', 'Synthetic release');

      gitIn(root, 'checkout', '-b', 'other');
      const pathOther = writeSchema(root, 'skill.v1.schema.json', { type: 'object', properties: {}, required: [] });
      gitIn(root, 'add', pathOther);
      gitIn(root, 'commit', '-m', 'Off-branch schema change');
      gitIn(root, 'tag', 'release/2026-11-99');

      gitIn(root, 'checkout', 'main');

      const withOptional = structuredClone(v1Skill);
      (withOptional.properties.parsers.items.properties as Record<string, unknown>).extra_note = { type: 'string' };
      writeSchema(root, 'skill.v1.schema.json', withOptional);
      writeSchema(root, 'new-future.v1.schema.json', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
      assert.deepEqual(schemaFreezeProblems(root), []);

      const deletedProp = structuredClone(v1Skill);
      delete (deletedProp.properties.parsers.items.properties as Record<string, unknown>).migration_test;
      writeSchema(root, 'skill.v1.schema.json', deletedProp);
      const deletedCheck = contractSchemaFreezeViolations(root);
      assert.equal(deletedCheck.errors.length, 0);
      assert.deepEqual(
        deletedCheck.violations.map((v) => [v.file, v.kind, v.path]),
        [['contracts/generated/schemas/skill.v1.schema.json', 'property-deleted', 'parsers[].migration_test']],
      );

      const turnedReq = structuredClone(v1Skill);
      turnedReq.properties.parsers.items.required.push('locate');
      writeSchema(root, 'skill.v1.schema.json', turnedReq);
      const reqCheck = contractSchemaFreezeViolations(root);
      assert.equal(reqCheck.errors.length, 0);
      assert.deepEqual(
        reqCheck.violations.map((v) => [v.file, v.kind, v.path]),
        [['contracts/generated/schemas/skill.v1.schema.json', 'turned-required', 'parsers[].locate']],
      );

      rmSync(join(root, pathSkill));
      const removedFileCheck = contractSchemaFreezeViolations(root);
      assert.deepEqual(
        removedFileCheck.violations.map((v) => v.kind),
        ['schema-deleted'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('compareJsonSchemas value widening and narrowing rules', () => {
  it('allows adding optional properties, adding new required=false properties in strict objects, and widening values', () => {
    const base = {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'alpha' },
        status: { type: 'string', enum: ['open', 'closed'] },
        count: { type: 'integer', minimum: 1, maximum: 100 },
        tag: { type: 'string', minLength: 2, maxLength: 20, pattern: '^[a-z]+$' },
        code: { type: 'string', format: 'uuid' },
        extra: { type: 'string' },
      },
      required: ['kind', 'status'],
      additionalProperties: false,
    };
    const widened = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['alpha', 'beta'] },
        status: { type: 'string', enum: ['open', 'closed', 'archived'] },
        count: { type: 'number', minimum: 0, maximum: 200 },
        tag: { type: 'string', minLength: 1, maxLength: 50 },
        code: { type: 'string' },
        extra: { type: ['string', 'null'] },
        added_optional: { type: 'boolean' },
      },
      required: ['kind'],
      additionalProperties: true,
    };
    assert.deepEqual(compareJsonSchemas(base, widened), []);
  });

  it('rejects deleted property, optional->required, added required property, and narrowed value domains', () => {
    const base = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'full', 'deep'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        label: { type: 'string', maxLength: 64 },
        nullable_text: { type: ['string', 'null'] },
      },
      required: ['mode'],
      additionalProperties: false,
    };
    const narrowed = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'full'] },
        limit: { type: 'integer', exclusiveMinimum: 1, maximum: 50 },
        label: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z]+$' },
      },
      required: ['mode', 'limit', 'brand_new_required'],
      additionalProperties: false,
    };
    const kinds = compareJsonSchemas(base, narrowed).map((v) => [v.kind, v.path]);
    assert.ok(kinds.some(([k, p]) => k === 'value-narrowed' && p === 'mode'));
    assert.ok(kinds.filter(([k, p]) => k === 'value-narrowed' && p === 'limit').length >= 2);
    assert.ok(kinds.filter(([k, p]) => k === 'value-narrowed' && p === 'label').length >= 3);
    assert.ok(kinds.some(([k, p]) => k === 'property-deleted' && p === 'nullable_text'));
    assert.ok(kinds.some(([k, p]) => k === 'turned-required' && p === 'limit'));
    assert.ok(kinds.some(([k, p]) => k === 'required-added' && p === 'brand_new_required'));
  });

  it('handles $defs/$ref cycles, unions, and conditional if/then/else constraints', () => {
    const base = {
      $defs: {
        node: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            child: { $ref: '#/$defs/node' },
          },
          required: ['name'],
        },
      },
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/node' },
        payload: {
          anyOf: [
            { type: 'object', properties: { kind: { const: 'a' }, val: { type: 'string' } }, required: ['kind'] },
            { type: 'object', properties: { kind: { const: 'b' }, n: { type: 'integer' } }, required: ['kind'] },
          ],
        },
      },
      allOf: [
        {
          if: { properties: { strict: { const: true } }, required: ['strict'] },
          then: { required: ['root'] },
        },
      ],
    };

    const extended = structuredClone(base);
    (extended.$defs.node.properties as Record<string, unknown>).tag = { type: 'string' };
    extended.properties.payload.anyOf.push({
      type: 'object',
      properties: { kind: { const: 'c' }, flag: { type: 'boolean' } },
      required: ['kind'],
    } as never);
    assert.deepEqual(compareJsonSchemas(base, extended), []);

    const brokenRef = structuredClone(base);
    delete (brokenRef.$defs.node.properties as Record<string, unknown>).name;
    const violations = compareJsonSchemas(base, brokenRef);
    assert.ok(violations.some((v) => v.kind === 'property-deleted' && v.path === 'root.name'));
  });
});
