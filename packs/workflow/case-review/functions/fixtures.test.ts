// The synthetic mind-map fixtures under tests/fixtures/mindmaps: reproducible from documents.ts, parseable, and in the
// structure of the real documents (ids, timestamps, wrapper, tags, priorities), with documentation addresses only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { compactText, fixtureFiles, largeDocument, reviewDocument, untaggedDocument, type KmNode } from '../../../../tests/fixtures/mindmaps/documents.ts';
import { MINDMAP_FIXTURES, fixtureText, type MindmapFixture } from '../../../../tests/fixtures/mindmaps/index.ts';
import { parseFixture, parseLarge } from '../testing/test-support.ts';

const walk = (node: KmNode, visit: (node: KmNode) => void): void => {
  visit(node);
  for (const child of node.children) walk(child, visit);
};

describe('the mind-map fixtures', () => {
  it('are exactly what documents.ts builds (run tests/fixtures/mindmaps/write.ts after a change)', () => {
    const files = fixtureFiles();
    assert.deepEqual(Object.keys(files).sort(), [...MINDMAP_FIXTURES].sort());
    for (const [name, text] of Object.entries(files)) assert.equal(fixtureText(name as MindmapFixture), text, name);
    assert.equal(compactText(largeDocument()), compactText(largeDocument()), 'the large document is deterministic');
  });

  it('parse with kityminder@1; the double-encoded and the agile forms carry the same document', () => {
    for (const name of MINDMAP_FIXTURES.filter((n) => n !== 'review-150.agile-response.json')) assert.ok(parseFixture(name).model.nodes.length > 0, name);
    assert.equal(parseFixture('review-150.double.json').model.doubleEncoded, true);
    assert.deepEqual(parseFixture('review-150.double.json').model.nodes, parseFixture('review-150.km.json').model.nodes);
    const raw = fixtureText('review-150.double.json');
    assert.ok(/^"\{\\"root\\": \{\\"data\\": \{\\"id\\": /.test(raw), 'inner JSON uses ", " and ": " separators');
    assert.ok(!/[^\x00-\x7f]/.test(raw), 'inner JSON escapes every non-ASCII character');
    const envelope = JSON.parse(fixtureText('review-150.agile-response.json')) as { code: number; msg: string; data: string };
    assert.equal(envelope.code, 1000);
    assert.deepEqual(JSON.parse(envelope.data), reviewDocument());
  });

  it('have the sizes the tests rely on', () => {
    assert.equal(parseFixture('review-150.km.json').model.nodes.length, 172);
    assert.equal(parseFixture('tiny.km.json').model.nodes.length, 4);
    assert.equal(parseFixture('untagged.km.json').model.nodes.length, 11);
    const large = parseLarge().model.nodes.length;
    assert.ok(large > 2900 && large < 3100, String(large));
  });

  it('follow the real node format', () => {
    for (const document of [reviewDocument(), largeDocument(), untaggedDocument(), JSON.parse(fixtureText('template.km.json')), JSON.parse(fixtureText('outline.km.json'))]) {
      assert.equal(document.version, '1.4.43');
      assert.ok(typeof document.template === 'string' && typeof document.theme === 'string');
      walk(document.root, (node) => {
        const data = node.data;
        assert.deepEqual(Object.keys(data).slice(0, 3), ['id', 'created', 'text']);
        assert.match(String(data.id), /^[0-9a-z]{12}$/);
        assert.ok(Number.isSafeInteger(data.created));
        assert.equal(typeof data.text, 'string');
        if (data.resource !== undefined) assert.ok(Array.isArray(data.resource) && data.resource.every((tag) => typeof tag === 'string'));
        if (data.autoid !== undefined) assert.match(String(data.autoid), /^[0-9]{18}$/);
      });
    }
  });

  it('place priorities where the sampled documents place them', () => {
    // Measured on the sampled maps: 20 occurs only on steps inside a case; 3 marks leaves (preconditions); an untagged node
    // with priority 2 always has children and no case below it. The review map injects one priority-20 typo on a case.
    for (const document of [reviewDocument(), untaggedDocument(), largeDocument()]) {
      const visit = (node: KmNode, insideCase: boolean): void => {
        const tagged = Array.isArray(node.data.resource) && node.data.resource.length > 0;
        const priority = node.data.priority;
        if (priority === 20 && node.data.text !== '非管理员账号不能修改健康检查') assert.ok(insideCase && !tagged && node.children.length > 0, `priority 20 on ${String(node.data.text)}`);
        if (priority === 2 && !tagged && !insideCase) {
          assert.ok(node.children.length > 0, String(node.data.text));
          const below = (child: KmNode): boolean => child.data.priority === 2 || (Array.isArray(child.data.resource) && child.data.resource.length > 0) || child.children.some(below);
          assert.ok(!node.children.some(below), String(node.data.text));
        }
        for (const child of node.children) visit(child, insideCase || tagged || (priority === 2 && !tagged));
      };
      visit(document.root, false);
    }
  });

  it('use documentation addresses only', () => {
    for (const name of MINDMAP_FIXTURES) {
      const text = readFileSync(new URL(`../../../../tests/fixtures/mindmaps/${name}`, import.meta.url), 'utf8');
      // The double-encoded forms escape every non-ASCII character; decode them to search the document text.
      const inner = name.endsWith('.km.json') ? null : name.includes('agile') ? (JSON.parse(text) as { data: string }).data : (JSON.parse(text) as string);
      const decoded = inner === null ? text : JSON.stringify(JSON.parse(inner));
      for (const match of decoded.matchAll(/(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9.])/g)) {
        assert.equal(`${match[1]}.${match[2]}.${match[3]}`, '192.0.2', `${name}: ${match[0]}`);
      }
      for (const match of decoded.matchAll(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi)) {
        if (/^\d+:\d+$/.test(match[0])) continue;
        assert.match(match[0].toLowerCase(), /^2001:db8:/, `${name}: ${match[0]}`);
      }
    }
  });
});
