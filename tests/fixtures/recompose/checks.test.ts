import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditFixtures, auditText } from './checks.ts';
import { buildFixtures } from './write.ts';
import { fixtureText, fixtureJson } from './index.ts';
import { parseManifest } from '../../../packs/workflow/case-compile/functions/manifest.ts';
import { readFileSync } from 'node:fs';
test('every imported twin and generated companion is synthetic and machine-path free', () => { for (const row of auditFixtures())
    assert.deepEqual(row.findings, [], row.file); });
test('the privacy audit rejects real-name shapes and non-documentation ranges without displaying values', () => { assert.ok(auditText(String.fromCharCode(65, 80, 86)).length); assert.ok(auditText([10, 0, 0, 1].join('.')).length); assert.deepEqual(auditText('192.0.2.21 2001:db8::21'), []); });
test('fixture generation is byte deterministic and all declared outputs match', () => { const a = buildFixtures(), b = buildFixtures(); assert.deepEqual(a, b); for (const [name, bytes] of Object.entries(a))
    assert.equal(fixtureText(name), bytes, name); });
test('both real-shaped synthetic bed manifests validate and share the same structural keys', () => { const a = JSON.parse(readFileSync(new URL('../../../packs/workflow/test-bed/examples/bed-topology.json', import.meta.url), 'utf8')), b = fixtureJson('bed-b.json'); assert.ok(parseManifest(a).ok); assert.ok(parseManifest(b).ok); assert.deepEqual(Object.keys(a.beds[0]).sort(), Object.keys(b.beds[0]).sort()); });
