import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, parseEnvText, pick } from './env-file.ts';

const TEXT = `﻿# comment line
ACTIVE_KEY = value-one
# ------GLM
# ANTHROPIC_BASE_URL=https://example.invalid/glm
# ANTHROPIC_API_KEY=glm-secret
# ----Other
# ANTHROPIC_API_KEY=other-secret
ANTHROPIC_API_KEY = active-secret
EMPTY =
`;

test('parses active and commented entries with their sections', () => {
  const entries = parseEnvText(TEXT);
  assert.equal(pick(entries, 'ACTIVE_KEY')?.value, 'value-one');
  assert.equal(pick(entries, 'ANTHROPIC_API_KEY', { section: 'glm' })?.value, 'glm-secret');
  assert.equal(pick(entries, 'ANTHROPIC_API_KEY')?.value, 'active-secret');
  assert.equal(pick(entries, 'EMPTY'), undefined);
});

test('describe never shows a value', () => {
  const lines = describe(parseEnvText(TEXT), ['ACTIVE_KEY', 'ANTHROPIC_API_KEY', 'MISSING']);
  assert.deepEqual(lines, ['ACTIVE_KEY: found, length 9', 'ANTHROPIC_API_KEY: found, length 13', 'MISSING: absent']);
  assert.ok(!lines.join('\n').includes('secret'));
});
