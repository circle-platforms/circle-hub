import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BASELINE_PATH,
  TOOLS_PATH,
  buildBaseline,
  compareInputSchemas,
  parseToolsJson,
  toolInputStabilityProblems,
  type ToolInputBaseline,
} from './tool-input-stability.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function baselineOf(): ToolInputBaseline {
  return JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as ToolInputBaseline;
}

function toolsOf(): Record<string, unknown>[] {
  const parsed = parseToolsJson(JSON.parse(readFileSync(join(ROOT, TOOLS_PATH), 'utf8')));
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

describe('tool input stability on the repository', () => {
  it('the six tools match the frozen baseline with no removed, retyped, or newly required input fields', () => {
    assert.deepEqual(toolInputStabilityProblems(ROOT), []);
  });

  it('the baseline covers exactly the tools in contracts/generated/tools.json', () => {
    const names = toolsOf().map((tool) => String(tool.name)).sort();
    assert.deepEqual(Object.keys(baselineOf()).sort(), names);
    assert.equal(names.length, 6);
  });
});

describe('compareInputSchemas', () => {
  const base: ToolInputBaseline = {
    demo_tool: {
      fields: { alpha: 'string', beta: 'integer', 'beta.gamma': 'boolean' },
      required: ['alpha'],
    },
  };

  it('accepts an unchanged schema and a new optional field', () => {
    assert.deepEqual(compareInputSchemas(base, base), []);
    const withOptional = structuredClone(base);
    withOptional.demo_tool.fields.delta = 'string';
    assert.deepEqual(compareInputSchemas(base, withOptional), []);
  });

  it('reports a removed field, including a nested one', () => {
    const shrunk = structuredClone(base);
    delete shrunk.demo_tool.fields['beta.gamma'];
    const violations = compareInputSchemas(base, shrunk);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'field-removed');
    assert.equal(violations[0].field, 'beta.gamma');
  });

  it('reports a changed type', () => {
    const retyped = structuredClone(base);
    retyped.demo_tool.fields.beta = 'string';
    const violations = compareInputSchemas(base, retyped);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'type-changed');
  });

  it('reports optional turning required', () => {
    const tightened: ToolInputBaseline = {
      demo_tool: { fields: { ...base.demo_tool.fields }, required: ['alpha', 'beta'] },
    };
    const violations = compareInputSchemas(base, tightened);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'turned-required');
  });

  it('reports a new required field and a new tool', () => {
    const extended: ToolInputBaseline = {
      demo_tool: { fields: { ...base.demo_tool.fields, epsilon: 'string' }, required: ['alpha', 'epsilon'] },
      other_tool: { fields: {}, required: [] },
    };
    const violations = compareInputSchemas(base, extended);
    assert.deepEqual(
      violations.map((v) => [v.tool, v.kind]),
      [
        ['demo_tool', 'required-added'],
        ['other_tool', 'required-added'],
      ],
    );
  });

  it('reports a removed tool', () => {
    const violations = compareInputSchemas(base, {});
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'field-removed');
  });
});

describe('buildBaseline', () => {
  it('flattens nested objects, arrays, and the required list', () => {
    const built = buildBaseline([
      {
        name: 'demo',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            list: { type: 'array', items: { type: 'object', properties: { b: { type: 'integer' } } } },
          },
          required: ['a'],
        },
      },
    ]);
    assert.deepEqual(built.demo.fields, { a: 'string', list: 'array', 'list[].b': 'integer' });
    assert.deepEqual(built.demo.required, ['a']);
  });
});
