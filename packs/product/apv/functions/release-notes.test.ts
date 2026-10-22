import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import releaseNotes, { produceReleaseEntries } from './release-notes.ts';
import type { ReleaseResult } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, internalWarnings, markdown, markdownDocument, seeded, sliceBytes } from '../testing/test-support.ts';

const document = markdownDocument(fixtureBytes('release-note.md'));
const result = produceReleaseEntries(document.model);

describe('release note entries', () => {
  it('reads product, version, build and release date from the opening', () => {
    assert.deepEqual([result.product, result.version, result.build, result.released], ['NSAE', '10.6.1.41', 'Rel_NSAE_10_6_1_41', '2026-05-22']);
  });

  it('reads fixed and known issues from lists, tables and HTML tables with their modules', () => {
    assert.deepEqual(
      result.entries.map((entry) => [entry.kind, entry.data.status, entry.data.module, entry.data.bugId ?? null, entry.data.text]),
      [
        ['defect', 'fixed', 'SLB', '61001', 'Bug 61001：HA 切换后虚拟服务的状态显示不正确。'],
        ['defect', 'fixed', 'SLB', '61002', '61002：成员池权重为 0 时调度异常， 修复后不再向该成员转发。'],
        ['defect', 'fixed', 'SLB', null, '修复了健康检查日志中的拼写错误。'],
        ['defect', 'fixed', 'SSL', '61010', '导入证书链时顺序错误。'],
        ['defect', 'fixed', 'SSL', '61011', '会话复用率统计偏低。'],
        ['defect', 'fixed', '登录', '61020', '登录页在窄屏下错位'],
        ['defect', 'fixed', '系统维护', '61021', '导出配置的文件名 缺少日期'],
        ['defect', 'known', 'HA', '61030', 'Bug 61030：在极端负载下同步可能延迟数秒。'],
        ['defect', 'known', 'HA', '61031', 'BUG#61031 配置回滚后需要重新登录。'],
        ['defect', 'known', '网络', '61040', 'VLAN 接口改名后 & 统计归零。'],
      ],
    );
    assert.ok(result.entries.every((entry) => entry.path === null && entry.data.build === 'Rel_NSAE_10_6_1_41'));
    assert.ok(result.entries.every((entry) => JSON.stringify(entry.applicability) === JSON.stringify({ builds: ['Rel_NSAE_10_6_1_41'] })));
    assert.equal(result.entries[0].statement, 'SLB：Bug 61001：HA 切换后虚拟服务的状态显示不正确。');
    assert.deepEqual(result.warnings, ['问题章节里有 1 个块不是列表、表格或段落，已跳过']);
  });

  it('cites each item by its block and the byte range of the item', () => {
    for (const entry of result.entries) {
      const [fragment] = entry.fragments;
      const located = document.locate(fragment.selector);
      assert.ok(located, fragment.selector);
      const part = fragment.range ? sliceBytes(located.text, fragment.range) : located.text;
      const id = entry.data.bugId as string | undefined;
      if (id !== undefined) assert.ok(part.includes(id), `${fragment.selector} ${part}`);
      // The item text starts in the cited part (tables split it into cells, so only its first characters are compared).
      assert.ok(part.includes(String(entry.data.text).slice(0, 4)), `${fragment.selector} ${part}`);
    }
  });

  it('reads an English release note without a header table', () => {
    const text = [
      '# APV 9.2.1 Release Notes (Rel_APV_9_2_1_7)',
      '',
      'Release Date: 2026/02/03',
      '',
      '## Fixed Issues',
      '',
      '- Bug 7001: the probe timer drifted.',
      '',
      '## Known Issues',
      '',
      'Bug 7002: the console wraps long lines.',
    ].join('\n');
    const english = produceReleaseEntries(markdown(text));
    assert.deepEqual([english.product, english.version, english.build, english.released], ['APV', '9.2.1', 'Rel_APV_9_2_1_7', '2026-02-03']);
    assert.deepEqual(english.entries.map((entry) => [entry.kind, entry.data.status, entry.data.module, entry.data.bugId]), [
      ['defect', 'fixed', null, '7001'],
      ['defect', 'known', null, '7002'],
    ]);
    assert.equal(english.entries[1].fragments[0].range, undefined);
  });

  it('says what is missing instead of guessing', () => {
    const bare = produceReleaseEntries(markdown('# 说明\n\n没有问题章节，日期 2026-02-30。\n'));
    assert.deepEqual([bare.product, bare.build, bare.released, bare.entries.length], [null, null, null, 0]);
    assert.ok(bare.warnings.includes('没有找到“已修复问题”或“遗留问题”章节'));
    assert.ok(bare.warnings.some((warning) => warning.includes('2026-02-30 不是有效日期')));
    assert.ok(bare.warnings.includes('标题和开头没有写产品名（APV 或 NSAE）'));
    assert.equal(releaseNotes({ model: document.model }).entries.length, result.entries.length);
  });

  it('is total and deterministic on hostile and random inputs', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(releaseNotes, input, `hostile ${k}`);
    const random = seeded(31);
    const pieces = ['# NSAE 10.6 说明\n\n', '## 已修复问题\n\n', '## 遗留问题\n\n', '### SLB\n\n', '- Bug 123：x\n', '1. 4567 y\n', '| Bug ID | 描述 |\n|---|---|\n| 8 | z |\n\n', '<table><tr><td>9', '</td></tr></table>\n\n', '+---+\n| a |\n+===+\n', '段落\n\n', '\u0000', '发布日期：2026年1月1日\n\n'];
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: random.int(12) }, () => random.pick(pieces)).join('');
      const doc = markdownDocument(text);
      const produced = assertTotal(releaseNotes, doc.model, text) as ReleaseResult;
      assert.deepEqual(internalWarnings(produced), []);
      for (const entry of produced.entries) {
        const [fragment] = entry.fragments;
        const located = doc.locate(fragment.selector);
        assert.ok(located);
        if (fragment.range) assert.ok(fragment.range[0] < fragment.range[1] && fragment.range[1] <= Buffer.byteLength(located.text, 'utf8'));
      }
    }
  });

  it('reads negated headings as known issues, never as fixes', () => {
    const noteWith = (heading: string) => produceReleaseEntries(markdown(`# NSAE 9.8.6 发布说明\n\n## ${heading}\n\n- 61001 SLB 会话保持偶发失效\n`));
    for (const heading of ['未修复问题', '尚未修复的问题', '没有修复的问题', '未能修复的问题', '未解决问题', '尚未解决的问题', 'Unfixed Issues', 'Unresolved Issues', 'Issues Not Fixed', 'Known Issues', '遗留问题']) {
      assert.deepEqual(noteWith(heading).entries.map((entry) => [entry.kind, entry.data.status, entry.data.bugId]), [['defect', 'known', '61001']], heading);
    }
    for (const heading of ['已修复问题', '修复的问题', '问题修复', '已解决问题', 'Fixed Issues', 'Bug Fixes', 'Resolved Issues']) {
      assert.deepEqual(noteWith(heading).entries.map((entry) => [entry.kind, entry.data.status, entry.data.bugId]), [['defect', 'fixed', '61001']], heading);
    }
    // English names only as whole words: "Prefixed issues" is not a fixed-issue section.
    const prefixed = noteWith('Prefixed issues table');
    assert.deepEqual(prefixed.entries, []);
    assert.ok(prefixed.warnings.includes('没有找到“已修复问题”或“遗留问题”章节'));
  });

  it('keeps HTML table offsets when lower-casing would change the length (İ)', () => {
    const text = '## 已修复问题\n\n<table>\n<tr><td>İİİİ</td><td>x</td></tr>\n<tr><td>61001</td><td>会话保持失效</td></tr>\n</table>\n';
    const doc = markdownDocument(text);
    const row = produceReleaseEntries(doc.model).entries.find((entry) => entry.data.bugId === '61001');
    assert.ok(row, 'bug 61001 is read');
    assert.equal(row.data.text, '会话保持失效');
    const [fragment] = row.fragments;
    assert.ok(fragment.range);
    assert.equal(sliceBytes(doc.locate(fragment.selector)?.text ?? '', fragment.range), '<tr><td>61001</td><td>会话保持失效</td></tr>');
  });

  it('reads a grid row of many lines in linear time', () => {
    const lines = ['## 已修复问题', '', '+--------+--------------------+', '| 编号   | 描述               |', '+========+====================+'];
    for (let k = 0; k < 20000; k++) lines.push(k === 0 ? '| 61001  | 第一行             |' : '|        | 续行文字           |');
    lines.push('+--------+--------------------+', '');
    const model = markdown(lines.join('\n'));
    const start = performance.now();
    const produced = produceReleaseEntries(model);
    const ms = performance.now() - start;
    assert.deepEqual(produced.entries.map((entry) => entry.data.bugId), ['61001']);
    assert.ok(String(produced.entries[0].data.text).startsWith('第一行 续行文字 续行文字'));
    assert.ok(ms < 1500, `took ${ms} ms`);
  });

  it('strips the tags of a cell full of stray < in linear time', () => {
    const model = markdown(`## 已修复问题\n\n<table><tr><td>61001</td><td>${'<'.repeat(200000)}</td></tr></table>\n`);
    const start = performance.now();
    const produced = produceReleaseEntries(model);
    const ms = performance.now() - start;
    assert.deepEqual(produced.entries.map((entry) => entry.data.bugId), ['61001']);
    assert.ok(ms < 1500, `took ${ms} ms`);
  });

  it('scans hostile and large HTML tables in linear time', () => {
    for (const rows of ['<tr><td>1'.repeat(40000), `<tr>${'<td>1'.repeat(40000)}</tr>`, '<tr><td>61</td><td>x</td></tr>'.repeat(20000)]) {
      const text = `## 已修复问题\n\n<table>${rows}</table>\n`;
      const start = performance.now();
      const produced = produceReleaseEntries(markdown(text));
      assert.ok(performance.now() - start < 2000);
      assert.ok(Array.isArray(produced.entries));
    }
  });
});
