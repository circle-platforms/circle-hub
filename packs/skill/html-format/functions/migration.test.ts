import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { htmlParser } from './html.ts';
import { originalCore, MIGRATION_TEST } from '../testing/baseline.ts';

function findHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) {
        results.push(...findHtmlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

test(MIGRATION_TEST, async (t) => {
  const baseline = await originalCore();
  t.after(() => baseline.close());

  let passed = 0;
  let rejected = 0;

  const check = (bytes: Uint8Array, label: string, options?: { mediaType?: string }) => {
    let expected: ReturnType<typeof baseline.parser.parse> | undefined;
    let baselineError: unknown;
    try {
      expected = baseline.parser.parse(bytes, options);
    } catch (e) {
      baselineError = e;
    }

    let actual: ReturnType<typeof htmlParser.parse> | undefined;
    let actualError: unknown;
    try {
      actual = htmlParser.parse(bytes, options);
    } catch (e) {
      actualError = e;
    }

    if (baselineError) {
      assert.ok(actualError, `${label} should also fail`);
      assert.equal((actualError as Error).name, (baselineError as Error).name, `${label} error name`);
      assert.equal((actualError as Error).message, (baselineError as Error).message, `${label} error message`);
      rejected++;
    } else {
      assert.ok(!actualError, `${label} unexpected error: ${(actualError as Error)?.message}`);
      assert.equal(JSON.stringify(actual!.model), JSON.stringify(expected!.model), `${label} model mismatch`);
      assert.equal(JSON.stringify(actual!.summary()), JSON.stringify(expected!.summary()), `${label} summary mismatch`);
      assert.deepEqual(actual!.listSelectors('', { properties: true }), expected!.listSelectors('', { properties: true }), `${label} selectors mismatch`);
      for (const sel of actual!.listSelectors('')) {
        assert.deepEqual(actual!.locate(sel), expected!.locate(sel), `${label} locate(${sel}) mismatch`);
      }
      if (actual!.model.blocks.length >= 2) {
        assert.deepEqual(actual!.locate('b/0-1'), expected!.locate('b/0-1'), `${label} locate(b/0-1) mismatch`);
      }
      passed++;
    }
  };

  // 1. All repository HTML fixtures
  const repoHtmls = findHtmlFiles(process.cwd());
  assert.ok(repoHtmls.length >= 10, `expected at least 10 repository html files, found ${repoHtmls.length}`);
  for (const path of repoHtmls) {
    const bytes = readFileSync(path);
    check(bytes, `repo file: ${path}`);
  }

  // 2. Synthetic windows-1252 HTML
  const latin1Html = Buffer.from('<html><head><title>Test \xa9 2026</title></head><body><h2>Heading</h2><p>Text with \xa3 and \xb1</p></body></html>', 'latin1');
  check(latin1Html, 'synthetic windows-1252');

  // 3. Synthetic UTF-8 with BOM
  const bomHtml = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html><body><p>UTF-8 带 BOM 和中文段落</p></body></html>')]);
  check(bomHtml, 'synthetic UTF-8 with BOM');

  // 4. Formatting tags and links
  const formattedHtml = Buffer.from('<html><body><p><b>Bold</b> <i>Italic</i> <font color="red"><a href="https://192.0.2.1/item">Link</a></font></p><pre>Code line 1\nLine 2</pre></body></html>');
  check(formattedHtml, 'synthetic formatting tags');

  // 5. Line breaks <br>
  const brHtml = Buffer.from('<html><body><p>Line 1<br>Line 2<br/>Line 3</p></body></html>');
  check(brHtml, 'synthetic br tags');

  // 6. Deep nesting within limits
  let nested = '<span>innermost</span>';
  for (let i = 0; i < 50; i++) nested = `<div>${nested}</div>`;
  check(Buffer.from(`<html><body>${nested}</body></html>`), 'synthetic 50-level nested HTML');

  // 7. Refused / error vectors
  check(Buffer.from('<div>'.repeat(300)), 'rejected depth limit (300 divs)');
  check(Buffer.from(`<i ${'x '.repeat(600)}>`), 'rejected attribute limit (600 attributes)');
  check(Buffer.from('<meta charset="unsupported-foo-encoding"><p>x</p>'), 'rejected unsupported charset');

  assert.ok(passed >= 10, `expected at least 10 passed documents, got ${passed}`);
  assert.ok(rejected >= 3, `expected at least 3 rejected documents, got ${rejected}`);
  t.diagnostic(JSON.stringify({ passed_documents: passed, rejected_vectors: rejected }));
});
