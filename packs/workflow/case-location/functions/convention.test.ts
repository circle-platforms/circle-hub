import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNames,
  lineKey,
  lineOfLabel,
  lineOfVersion,
  moduleOfLabel,
  notAVersion,
  parseLabel,
  pureVersionOf,
  sameLine,
  schemeScan,
  trainOfLabel,
  versionsAgree,
  writtenBuilds,
} from './convention.ts';
import { hasIds } from './ids.ts';

const scan = (text: string) => schemeScan(parseLabel(text).text).matches.map((m) => [m.kind, m.value]);

describe('folder labels', () => {
  it('splits the prefix code from the label, ASCII or full-width colon, grouped codes', () => {
    assert.deepEqual(parseLabel('060：10.6.1'), { text: '060:10.6.1', code: '060', rest: '10.6.1' });
    assert.deepEqual(parseLabel('000-001-002：HA'), { text: '000-001-002:HA', code: '000-001-002', rest: 'HA' });
    assert.equal(parseLabel('a10: 10.7.0-BANK').code, 'a10');
    assert.equal(parseLabel('０６０：１０.６.１').rest, '10.6.1');
    // A code needs a digit and exactly three characters per group.
    for (const label of ['SSL:设置', 'ABCD:10.6.1', '10.6.1', '：10.6.1', '06：10.6.1']) assert.equal(parseLabel(label).code, null, label);
  });

  it('reads line nodes and release trains only with a prefix code, never an address', () => {
    assert.equal(lineOfLabel(parseLabel('060：10.6.1')), '10.6.1');
    assert.equal(lineOfLabel(parseLabel('060：V10.6')), '10.6');
    assert.equal(lineOfLabel(parseLabel('10.6.1')), null);
    assert.equal(lineOfLabel(parseLabel('060：10.6.1 专项')), null);
    assert.equal(lineOfLabel(parseLabel('060：192.0.2.10')), null);
    assert.deepEqual(trainOfLabel(parseLabel('004：10.6.1-R2-2026/7')), { train: '10.6.1-R2-2026/7', version: '10.6.1' });
    assert.deepEqual(trainOfLabel(parseLabel('301：10.6.2 主线HG UOS-2026/08/02')), { train: '10.6.2 主线HG UOS-2026/08/02', version: '10.6.2' });
    assert.equal(trainOfLabel(parseLabel('10.7.3 迁移回归')), null);
    assert.equal(trainOfLabel(parseLabel('004：10.6.1-')), null);
    assert.equal(trainOfLabel(parseLabel('004：10.6.1')), null);
    assert.equal(trainOfLabel(parseLabel('101：192.0.2.10-网段')), null);
  });

  it('takes a module only when it is a plain name', () => {
    const module = (label: string) => moduleOfLabel(parseLabel(label), hasIds);
    for (const [label, name] of [
      ['SSL', 'SSL'],
      ['000-001-002：HA', 'HA'],
      ['WebUI', 'WebUI'],
      ['系统', '系统'],
      ['TLS1.3 握手', 'TLS1.3 握手'],
    ]) {
      assert.equal(module(label), name, label);
    }
    for (const label of ['bug to case 61001', '61001-会话保持', '回归测试', '需求 7001', '10.6.1第二阶段测试', '9.9.9 迁移引用', 'build20260101', 'patch2 专项', '2026/07 版本', '', 'x'.repeat(41)]) {
      assert.equal(module(label), null, label);
    }
  });

  it('reads a label that is only a version (the owner expression over the whole label) as a version label', () => {
    for (const [label, version] of [
      ['10.6.1', '10.6.1'],
      ['V10.7.0', '10.7.0'],
      ['NSAE_10.7.3', '10.7.3'],
      ['APV-10.7.6', '10.7.6'],
      ['060：10.6.1', '10.6.1'],
      ['060：NSAE_10.6.1', '10.6.1'],
      ['１０.６.１', '10.6.1'],
    ]) {
      assert.equal(pureVersionOf(parseLabel(label)), version, label);
    }
    for (const label of ['NSAE_10.6.1.57_专项', 'V10.7.0 专项测试', '802.1Q VLAN', 'Chrome 120.0 兼容', 'OpenSSL 1.1.1 升级', 'patch1.2', 'TLSv1.3', 'SSL3.0', '192.0.2.10', '10.6.1-R2-2026/7', 'build20260315', '']) {
      assert.equal(pureVersionOf(parseLabel(label)), null, label);
    }
  });
});

describe('the version scheme', () => {
  it('reads build dates, patches and versions in priority order', () => {
    assert.deepEqual(scan('build20260315 回归'), [['build', '20260315']]);
    assert.deepEqual(scan('Build_20260315'), [['build', '20260315']]);
    assert.deepEqual(scan('patch2'), [['patch', '2']]);
    assert.deepEqual(scan('Patch 1.2 专项'), [['patch', '1.2']]);
    assert.deepEqual(scan('NSAE_10.7.3_patch3'), [['version', '10.7.3'], ['patch', '3']]);
    assert.deepEqual(scan('APV 10.7.0 build20260110'), [['version', '10.7.0'], ['build', '20260110']]);
    assert.deepEqual(scan('10.7.0-build20260402-2026/4'), [['version', '10.7.0'], ['build', '20260402']]);
    assert.deepEqual(scan('hotpatch2'), [['patch', '2']]);
  });

  it('reads versions of two to four numbers with letters or v before them', () => {
    for (const [label, version] of [
      ['060：10.6.1', '10.6.1'],
      ['V10.7.0 专项', '10.7.0'],
      ['v9.8', '9.8'],
      ['APV_10.7.6', '10.7.6'],
      ['NSAE-10.6.1.57', '10.6.1.57'],
      ['R10.6.2', '10.6.2'],
      ['10.6.1-R2-2026/7', '10.6.1'],
      ['１０.６.１', '10.6.1'],
    ]) {
      assert.deepEqual(scan(label), [['version', version]], label);
    }
  });

  it('never reads dates, long numbers, five-part numbers, invalid build dates or malformed patches as versions', () => {
    for (const label of ['2026.06.30', '2026/7', '20260315', '1234.5', '10.6.1.2.3', 'build20261345', 'patch1.2.3', 'Rel_APV_10_6_1_57', '3.', '.5']) {
      assert.deepEqual(scan(label).filter(([kind]) => kind === 'version'), [], label);
    }
    assert.deepEqual(schemeScan('build20261345').rejects, [{ kind: 'build', text: 'build20261345' }]);
    assert.deepEqual(schemeScan('patch1.2.3').rejects, [{ kind: 'patch', text: 'patch1.2.3' }]);
    assert.deepEqual(scan('patch2.'), [['patch', '2']]);
  });

  it('guards against protocol versions, quantities and addresses', () => {
    for (const label of ['TLSv1.3 握手', 'SSL3.0 兼容', 'HTTP/1.1 长连接', 'tls 1.2', 'DTLS1.2', 'TLS v1.3', '1.5倍压力', '0.5 秒超时', '2.5GB 内存', '12.5%', '192.0.2.10 地址测试', '192.0.2.0/24 网段', '192.0.2.7:8080']) {
      assert.deepEqual(scan(label), [], label);
    }
    assert.equal(notAVersion('TLSv1.3', 4, 7, '1.3'), 'protocol');
    assert.equal(notAVersion('1.5倍', 0, 3, '1.5'), 'quantity');
    assert.equal(notAVersion('192.0.2.10', 0, 10, '192.0.2.10'), 'address');
    // A number followed by a prefix length or a port is an address too, whatever its first part.
    assert.equal(notAVersion('10.6.1/24', 0, 6, '10.6.1'), 'address');
    assert.equal(notAVersion('10.6.1:80', 0, 6, '10.6.1'), 'address');
    assert.equal(notAVersion('10.6.1 SSL', 0, 6, '10.6.1'), null);
    // The guards look only right before and right after the number, and after a space only at short protocol versions.
    assert.deepEqual(scan('SSL 10.6.1 卸载'), [['version', '10.6.1']]);
    assert.deepEqual(scan('HTTPS 10.7.0 专项'), [['version', '10.7.0']]);
  });
});

describe('version lines and build names', () => {
  it('compares lines as the product pack does, versions by dotted prefix and by their version line', () => {
    assert.equal(lineKey('10.6.0'), '10.6');
    assert.equal(lineKey('010.6'), '10.6');
    assert.equal(lineKey('V10.6.1'), '10.6.1');
    assert.ok(versionsAgree('10.6', '10.6.1'));
    assert.ok(versionsAgree('10.6.1.57', '10.6.1'));
    assert.ok(versionsAgree('010.6', '10.6'));
    assert.ok(!versionsAgree('10.6.0', '10.6.1'));
    assert.ok(!versionsAgree('10.7.3', '10.6.1'));
    assert.equal(lineOfVersion('10.6.1.57'), '10.6.1');
    assert.equal(lineOfVersion('10.6'), '10.6');
    // The same version line: the first three numbers compared as lines.
    assert.ok(sameLine('10.6.1.57', '10.6.1'));
    assert.ok(sameLine('10.6.0', '10.6'));
    assert.ok(sameLine('010.6.1', '10.6.1'));
    assert.ok(!sameLine('10.6', '10.6.1'));
    assert.ok(!sameLine('9.8', '10.6'));
    assert.ok(!sameLine('10.6.2', '10.6.1'));
  });

  it('finds build names as written', () => {
    assert.deepEqual(
      buildNames('Rel_NSAE_10_6_1_57 回归，对比 Rel_APV-HG-K_10_6_1_8_4_129 和 Beta.APV.10.7.0.3').map((b) => b.name),
      ['Rel_NSAE_10_6_1_57', 'Rel_APV-HG-K_10_6_1_8_4_129', 'Beta.APV.10.7.0.3'],
    );
    assert.deepEqual(buildNames('XRel_APV_10_6_1_57 Rel_APV_10'), []);
  });

  it('lists only the written names of the line families, verbatim, and never makes one up', () => {
    const names = ['APV', 'NSAE'];
    // No twin in the other family (an older NSAE build is based on an APV build with another number).
    assert.deepEqual(writtenBuilds(['Rel_NSAE_10_9_1_37 回归'], names, 24), { names: ['Rel_NSAE_10_9_1_37'], foreign: [] });
    assert.deepEqual(writtenBuilds(['Rel_APV-HG-K_10_6_1_8_4_129'], names, 24), { names: ['Rel_APV-HG-K_10_6_1_8_4_129'], foreign: [] });
    // Another product's build is left out and reported; a version alone gives no name; the same name is listed once.
    assert.deepEqual(writtenBuilds(['Rel_OTHERPROD_9_1_0_3 对比', 'NSAE_10.6.1.57', 'Rel_nsae_10_6_1_57', 'Rel_NSAE_10_6_1_57'], names, 24), { names: ['Rel_nsae_10_6_1_57', 'Rel_NSAE_10_6_1_57'], foreign: ['Rel_OTHERPROD_9_1_0_3'] });
    // Without the names of a line (an unbound run) nothing is listed.
    assert.deepEqual(writtenBuilds(['Rel_NSAE_10_9_1_37'], [], 24), { names: [], foreign: ['Rel_NSAE_10_9_1_37'] });
    assert.equal(writtenBuilds([Array.from({ length: 40 }, (_, k) => `Rel_APV_10_6_1_${k}`).join(' ')], names, 5).names.length, 5);
  });
});
