import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('local work-language schemas, isolated stage copies and slots regenerate byte-for-byte in a scratch tree', () => { const paths = ['tables/recompose-record.schema.json', 'tables/recompose-sources.schema.json', 'tables/recompose-product.schema.json', 'recompose/slots.schema.json', 'recompose/functions/recompose-check.ts', 'authority/functions/recompose-authority.ts', 'adjudicate/functions/recompose-evidence.ts']; const root = fileURLToPath(new URL('../', import.meta.url)), before = paths.map(p => readFileSync(join(root, p), 'utf8')), scratch = mkdtempSync(join(tmpdir(), 'recompose-gen-')); try {
    cpSync(root, scratch, { recursive: true });
    execFileSync(process.execPath, [join(scratch, 'testing/gen-recompose.ts')], { cwd: scratch, stdio: 'pipe' });
    assert.deepEqual(paths.map(p => readFileSync(join(scratch, p), 'utf8')), before);
}
finally {
    rmSync(scratch, { recursive: true, force: true });
} });
