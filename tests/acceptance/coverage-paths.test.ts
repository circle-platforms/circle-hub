// Asserts that every file path and scenario referenced in docs/hub-r4-coverage.md
// exists on disk. If any referenced path does not exist, this test fails.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const COVERAGE_MD_PATH = resolve(REPO_ROOT, 'docs/hub-r4-coverage.md');

describe('coverage audit path integrity', () => {
  test('every file path referenced in docs/hub-r4-coverage.md must exist on disk', () => {
    assert.ok(existsSync(COVERAGE_MD_PATH), 'docs/hub-r4-coverage.md must exist');
    const content = readFileSync(COVERAGE_MD_PATH, 'utf8');

    // Matches repository relative paths: contracts/..., hub/..., packs/..., tests/..., scripts/..., tools/..., docs/...
    const pathRegex = /\b((?:contracts|hub|packs|tests|scripts|tools|docs)\/[A-Za-z0-9_\-./]+(?:\.[a-zA-Z0-9]+)?)\b/g;
    const matches = new Set<string>();
    for (const match of content.matchAll(pathRegex)) {
      let p = match[1];
      // strip trailing dots or punctuation
      p = p.replace(/[),;:]+$/, '');
      matches.add(p);
    }

    assert.ok(matches.size > 20, `expected at least 20 path references, found ${matches.size}`);

    const missing: string[] = [];
    for (const relPath of matches) {
      const fullPath = resolve(REPO_ROOT, relPath);
      if (!existsSync(fullPath)) {
        missing.push(relPath);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `The following paths referenced in docs/hub-r4-coverage.md do not exist:\n${missing.join('\n')}`
    );
  });

  test('every scenario number mentioned in docs/hub-r4-coverage.md has a corresponding test file', () => {
    const content = readFileSync(COVERAGE_MD_PATH, 'utf8');
    const scenarioRegex = /场景\s*(\d{2})/g;
    const scenarioNumbers = new Set<string>();
    for (const match of content.matchAll(scenarioRegex)) {
      scenarioNumbers.add(match[1]);
    }

    assert.ok(scenarioNumbers.size >= 22, `expected at least 22 scenarios, found ${scenarioNumbers.size}`);

    const acceptanceFiles = readdirSync(resolve(REPO_ROOT, 'tests/acceptance'));
    const missingScenarios: string[] = [];

    for (const num of scenarioNumbers) {
      const prefix = `${num}-`;
      const found = acceptanceFiles.some((f) => f.startsWith(prefix) && f.endsWith('.test.ts'));
      if (!found) {
        missingScenarios.push(num);
      }
    }

    assert.deepEqual(
      missingScenarios,
      [],
      `The following scenarios mentioned in docs/hub-r4-coverage.md lack test files:\n${missingScenarios.join('\n')}`
    );
  });
});
