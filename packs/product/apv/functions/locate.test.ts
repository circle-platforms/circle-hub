import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import locate, { locateFromAncestors, stripPrefix } from './locate.ts';
import { assertTotal, hostileInputs, internalWarnings, randomText, seeded } from '../testing/test-support.ts';

const ROOT = ['DEMO', '030：产品测试项目'];

describe('location from the agile tree', () => {
  it('reads line, train and module under the product project', () => {
    assert.deepEqual(locateFromAncestors([...ROOT, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL']), { line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SSL', notes: [] });
    assert.deepEqual(locateFromAncestors([...ROOT, '010: 9.2', '101: 9.2-主线-CentOS-2025/06/30', '020: 网络']), { line: '9.2', train: '9.2-主线-CentOS-2025/06/30', module: '网络', notes: [] });
  });

  it('takes trains with customer and bank suffixes and prefixes with letters', () => {
    const bank = locateFromAncestors([...ROOT, '070：10.7.0', 'a10：10.7.0-BANK-20260625', 'WebUI']);
    assert.deepEqual([bank.line, bank.train, bank.module], ['10.7.0', '10.7.0-BANK-20260625', 'WebUI']);
    const space = locateFromAncestors([...ROOT, '030：10.6.2', '301：10.6.2 主线HG UOS-2026/08/02', '000-001-002：HA']);
    assert.deepEqual([space.line, space.train, space.module], ['10.6.2', '10.6.2 主线HG UOS-2026/08/02', 'HA']);
  });

  it('normalizes full-width colons, digits and spaces', () => {
    assert.equal(stripPrefix('０６０：１０．６．１'), '10.6.1');
    assert.deepEqual(locateFromAncestors(['０６０：１０.６.１', '００４：１０.６.１－Ｒ１－２０２６/７', '认证']).train, '10.6.1-R1-2026/7');
    assert.equal(stripPrefix('SSL:设置'), 'SSL:设置');
  });

  it('says what is missing or inconsistent', () => {
    const noTrain = locateFromAncestors([...ROOT, '060：10.6.1', 'SSL']);
    assert.deepEqual([noTrain.line, noTrain.train, noTrain.module], ['10.6.1', null, null]);
    assert.ok(noTrain.notes.includes('祖先里没有发布火车节点'));
    const noLine = locateFromAncestors([...ROOT, '004：10.6.1-R2-2026/7', 'SLB']);
    assert.equal(noLine.line, '10.6.1');
    assert.ok(noLine.notes.some((note) => note.includes('版本线取自发布火车')));
    const mismatch = locateFromAncestors([...ROOT, '060：10.6.1', '004：10.6.2-R2-2026/7', 'SLB']);
    assert.ok(mismatch.notes.some((note) => note.includes('不一致')));
    const nothing = locateFromAncestors(['DEMO', '010：通用用例集', '其他']);
    assert.deepEqual([nothing.line, nothing.train, nothing.module], [null, null, null]);
    assert.ok(nothing.notes.includes('祖先里没有版本线节点'));
  });

  it('does not take a document folder for a module', () => {
    for (const label of ['bug to case 61001', '61001-会话保持', '回归测试', 'IT环境 回归测试', '需求 7001', '10.6.1第二阶段测试']) {
      const result = locateFromAncestors([...ROOT, '060：10.6.1', '004：10.6.1-R2-2026/7', label]);
      assert.equal(result.module, null, label);
      assert.ok(result.notes.some((note) => note.includes('不是模块名')), label);
    }
    assert.equal(locateFromAncestors([...ROOT, '060：10.6.1', '004：10.6.1-R2-2026/7']).module, null);
  });

  it('takes the version line nearest the document when there are several', () => {
    const result = locateFromAncestors([...ROOT, '010：9.2', '020：10.6', '101：10.6-主线-2026/01', 'SLB']);
    assert.equal(result.line, '10.6');
    assert.ok(result.notes.some((note) => note.includes('多个版本线节点')));
  });
});

describe('location on bad input', () => {
  it('is total and deterministic on hostile and random labels', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(locate, input, `hostile ${k}`);
    assert.deepEqual(locate({ labels: [...ROOT, '060：10.6.1'] }), locateFromAncestors([...ROOT, '060：10.6.1']));
    const random = seeded(41);
    const labels = ['060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL', '030：产品测试项目', 'bug to case 1', '10.6', '：', '000-001-002：HA'];
    for (let i = 0; i < 500; i++) {
      const path = Array.from({ length: random.int(8) }, () => (random.chance(0.3) ? randomText(random, 20) : random.pick(labels)));
      const result = assertTotal(locate, path, JSON.stringify(path)) as ReturnType<typeof locateFromAncestors>;
      assert.deepEqual(internalWarnings(result), []);
      if (result.line !== null) assert.match(result.line, /^\d{1,3}(?:\.\d{1,3}){1,3}$/);
    }
    const long = locateFromAncestors(Array.from({ length: 100 }, () => `060：10.6.1${'x'.repeat(5000)}`));
    assert.ok(long.notes.some((note) => note.includes('只看前 64 个')));
  });
});
