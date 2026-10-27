import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { xmlParser } from './xml.ts';
import { originalCore, MIGRATION_TEST } from '../testing/baseline.ts';

function findXmlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) {
        results.push(...findXmlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.xml')) {
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

    let actual: ReturnType<typeof xmlParser.parse> | undefined;
    let actualError: unknown;
    try {
      actual = xmlParser.parse(bytes, options);
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
      passed++;
    }
  };

  // 1. All repository XML fixtures
  const rootXmls = findXmlFiles(process.cwd());
  assert.ok(rootXmls.length >= 6, `expected at least 6 repository xml files, found ${rootXmls.length}`);
  for (const path of rootXmls) {
    const bytes = readFileSync(path);
    check(bytes, `repo file: ${path}`);
  }

  // 2. Synthetic Latin1 XML
  const latin1Xml = Buffer.from("<?xml version='1.0' encoding='ISO-8859-1'?><commands scope='global'><cmd name='caf\xe9' help='t\xe9st \xb1 5 \xb0C'/></commands>", 'latin1');
  check(latin1Xml, 'synthetic ISO-8859-1');

  // 3. Synthetic UTF-8 with BOM
  const bomXml = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0" encoding="utf-8"?><root><item>中文 &amp; 特殊字符</item></root>')]);
  check(bomXml, 'synthetic UTF-8 with BOM');

  // 4. Synthetic irregular start tags tolerated by saxes repair pass
  const irregularXml = Buffer.from('<root><a x="1" y=2 z="hello <world>" duplicate="1" duplicate="2"/><b val="say \\"hi\\""/></root>');
  check(irregularXml, 'synthetic irregular start tags');

  // 5. Deep nesting and multiple sibling tags
  let nested = '<leaf text="deep"/>';
  for (let i = 0; i < 30; i++) nested = `<node level="${i}">${nested}</node>`;
  check(Buffer.from(`<root>${nested}</root>`), 'synthetic 30-level nested XML');

  // 6. Multiple siblings with same name
  const siblings = Array.from({ length: 50 }, (_, i) => `<item id="${i}">content ${i}</item>`).join('');
  check(Buffer.from(`<catalog>${siblings}</catalog>`), 'synthetic 50 sibling elements');

  // 7. Refused / error vectors
  check(Buffer.from('<root><unclosed></root>'), 'rejected unclosed tag');
  check(Buffer.from('<?xml version="1.0"?><!DOCTYPE root [<!ENTITY foo "bar">]><root>&foo;</root>'), 'rejected entity declaration in doctype');
  check(Buffer.from('not xml at all'), 'rejected non-xml plain text');
  check(Buffer.alloc(0), 'rejected empty');

  assert.ok(passed >= 10, `expected at least 10 passed documents, got ${passed}`);
  assert.ok(rejected >= 4, `expected at least 4 rejected documents, got ${rejected}`);
  t.diagnostic(JSON.stringify({ passed_documents: passed, rejected_vectors: rejected }));
});
