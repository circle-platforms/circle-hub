// fixedBugEntries against the build site's fixed-bug list as it really is: one body block of br-separated anchors
// (the anchor text is the bug number; the href names the defect system), some pages with a "======ID from PLM======="
// marker and bare numbers after it. The older shapes (a number table cell with its summary cell, a line starting with
// a number) stay. Synthetic pages and numbers only; hosts are example.invalid. Fragment selectors are located again
// with the real parser (they must resolve).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProducerOutput } from '../../../../contracts/src/product.ts';
import { htmlParser } from '../../../../hub/refs/parsers/html.ts';
import { html } from '../testing/test-support.ts';
import { fixedBugEntries } from './fixed-bugs.ts';

const BUILD = 'Rel_APV_10_6_1_57';
const PLM = (id: string) => `http://plm.example.invalid/cb?m=bug&f=view&id=${id}`;
const BZ = (id: string) => `http://bugs.example.invalid/show_bug.cgi?id=${id}`;

function locateEach(page: string, out: ReturnType<typeof fixedBugEntries>): void {
  const parsed = htmlParser.parse(new TextEncoder().encode(page));
  for (const entry of out.entries) {
    for (const fragment of entry.fragments) {
      const located = parsed.locate(fragment.selector);
      assert.ok(located !== null, `fragment ${fragment.selector} of bug ${String(entry.data.bug)} locates`);
      assert.ok(located.text.includes(String(entry.data.bug)), `fragment ${fragment.selector} of bug ${String(entry.data.bug)} holds the number`);
    }
  }
}

describe('fixedBugEntries on the real page shape (br-separated anchors)', () => {
  it('reads every numeric anchor and tells the two defect systems apart by href', () => {
    const page = `<html><body><a href=${PLM('70412')}>70412</a><br><a href=${BZ('61001')}>61001</a><br><a href="https://tracker.example.invalid/items/61002">61002</a><br><a href="https://www.example.invalid/docs">使用说明</a></body></html>`;
    const out = fixedBugEntries(html(page), BUILD);
    assert.ok(ProducerOutput.safeParse(out).success, JSON.stringify(out).slice(0, 400));
    locateEach(page, out);
    assert.deepEqual(
      out.entries.map((e) => [e.data.bug, e.data.system, e.fragments[0].selector]),
      [
        ['70412', 'plm', 'a/0'],
        ['61001', 'bugzilla', 'a/1'],
        ['61002', 'unknown', 'a/2'],
      ],
    );
    for (const entry of out.entries) {
      assert.equal(entry.kind, 'defect');
      assert.equal(entry.path, null);
      assert.equal(entry.data.status, 'fixed');
      assert.equal(entry.data.text, '');
      assert.equal(entry.data.build, BUILD);
      assert.equal(entry.data.form, 'fixed_list');
      assert.deepEqual(entry.applicability, { builds: [BUILD] });
      assert.equal(entry.statement, `缺陷 ${String(entry.data.bug)}`);
    }
  });

  it('reads the bare numbers after the "ID from PLM" marker as plm, flagged, each number once', () => {
    const page = `<html><body><a href=${PLM('70412')}>70412</a><br><a href=${PLM('70413')}>70413</a><br>======ID from PLM=======<br>70412 <br>70510 <br>70511</body></html>`;
    const out = fixedBugEntries(html(page), BUILD);
    assert.ok(ProducerOutput.safeParse(out).success);
    locateEach(page, out);
    assert.deepEqual(
      out.entries.map((e) => [e.data.bug, e.data.system, e.data.after_plm_marker === true, e.fragments[0].selector]),
      [
        ['70412', 'plm', false, 'a/0'],
        ['70413', 'plm', false, 'a/1'],
        ['70510', 'plm', true, 'b/0'],
        ['70511', 'plm', true, 'b/0'],
      ],
    );
    assert.ok(out.warnings.some((w) => w.includes('70412') && w.includes('只取第一次')), 'the duplicate is warned once');
  });

  it('a single-anchor page yields one entry', () => {
    const page = `<html><body><a href=${PLM('70412')}>70412</a></body></html>`;
    const out = fixedBugEntries(html(page), BUILD);
    locateEach(page, out);
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].data.bug, '70412');
    assert.equal(out.entries[0].data.system, 'plm');
    assert.equal(out.entries[0].fragments[0].selector, 'a/0');
  });

  it('an empty page and a page without numbers give no entry and the warning', () => {
    assert.deepEqual(fixedBugEntries({ blocks: [] }, null), { entries: [], warnings: ['修复缺陷清单里没有认出缺陷编号'] });
    const page = '<html><body><p>这个构建没有修复缺陷。</p></body></html>';
    const out = fixedBugEntries(html(page), BUILD);
    assert.deepEqual(out.entries, []);
    assert.deepEqual(out.warnings, ['修复缺陷清单里没有认出缺陷编号']);
  });

  it('a number listed as an anchor and again after the marker is taken once, from the anchor', () => {
    const page = `<html><body><a href=${BZ('61001')}>61001</a><br><a href=${BZ('61001')}>61001</a><br>======ID from PLM=======<br>61001 <br>61002</body></html>`;
    const out = fixedBugEntries(html(page), BUILD);
    locateEach(page, out);
    assert.deepEqual(
      out.entries.map((e) => [e.data.bug, e.data.system, e.fragments[0].selector]),
      [
        ['61001', 'bugzilla', 'a/0'],
        ['61002', 'plm', 'b/0'],
      ],
    );
    assert.equal(out.warnings.filter((w) => w.includes('61001')).length, 2, 'both repeats are warned');
  });
});

describe('fixedBugEntries keeps the older shapes (other pages may look like that)', () => {
  it('a number table cell takes its summary cell, and a paragraph starting with a number takes the rest as the summary', () => {
    const page = '<html><body><table><tr><th>Bug ID</th><th>Summary</th></tr><tr><td>61002</td><td>权重为 0 时调度异常</td></tr></table><p>61003: 拼写错误</p></body></html>';
    const out = fixedBugEntries(html(page), BUILD);
    assert.ok(ProducerOutput.safeParse(out).success);
    locateEach(page, out);
    assert.deepEqual(
      out.entries.map((e) => [e.data.bug, e.data.system, e.fragments[0].selector, e.statement]),
      [
        ['61002', 'unknown', 'b/2-3', '缺陷 61002：权重为 0 时调度异常'],
        ['61003', 'unknown', 'b/4', '缺陷 61003：拼写错误'],
      ],
    );
  });

  it('a number cell that is itself an anchor goes through the links path with an unknown system and the anchor fragment', () => {
    const page = '<html><body><table><tr><th>Bug ID</th><th>Summary</th></tr><tr><td><a href=x?id=61001>61001</a></td><td>HA 切换后状态不对</td></tr></table></body></html>';
    const out = fixedBugEntries(html(page), BUILD);
    locateEach(page, out);
    assert.deepEqual(out.entries.map((e) => [e.data.bug, e.data.system, e.fragments[0].selector]), [['61001', 'unknown', 'a/0']]);
  });
});
