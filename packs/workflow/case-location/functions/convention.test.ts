// The declared directory grammar of the bound line (famx-directory@1) on invented labels. Every row states what the
// grammar reads; the rows were written from the declaration in functions/convention.ts, not from the function's answer.
// Owner rule 2026-10-24 (R6, U23, U24): a layer is read from a whole label by syntax only — no NFKC, case or width
// folding, no activity/protocol/unit/address word guards, and nothing extracted out of prose. What the grammar does not
// read is null here and an unknown layer with the author's exit in the answer.
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
  versionForm,
  versionsAgree,
  writtenBuilds,
} from './convention.ts';
import { hasIds } from './ids.ts';

/** The names a run binds for this line: a declared closed set, compared exactly. */
const NAMES = ['FAMX', 'FAMY'];
const scan = (text: string) => schemeScan(parseLabel(text).rest, NAMES).matches.map((m) => [m.kind, m.value]);

describe('folder labels', () => {
  it('splits the prefix code from the label, ASCII or full-width colon, grouped codes', () => {
    // The label is kept exactly as the tree wrote it: the full-width colon stays in the text, only the declared separator
    // is recognised.
    assert.deepEqual(parseLabel('060：10.6.1'), { text: '060：10.6.1', code: '060', rest: '10.6.1' });
    assert.deepEqual(parseLabel('060:10.6.1'), { text: '060:10.6.1', code: '060', rest: '10.6.1' });
    assert.deepEqual(parseLabel('000-001-002：HA'), { text: '000-001-002：HA', code: '000-001-002', rest: 'HA' });
    assert.equal(parseLabel('a10: 10.7.0-BANK').code, 'a10');
    // A code needs a digit and exactly three ASCII characters per group; anything else leaves the layer unread.
    for (const label of ['SSL:设置', 'ABCD:10.6.1', '10.6.1', '：10.6.1', '06：10.6.1', '060-10.6.1']) {
      assert.equal(parseLabel(label).code, null, label);
      assert.equal(parseLabel(label).rest, parseLabel(label).text, label);
    }
    // Full-width digits are not folded into the declared code grammar: the layer is unread, not silently normalized.
    assert.deepEqual(parseLabel('０６０：１０.６.１'), { text: '０６０：１０.６.１', code: null, rest: '０６０：１０.６.１' });
  });

  it('reads line nodes and release trains only with a prefix code, by syntax alone', () => {
    assert.equal(lineOfLabel(parseLabel('060：10.6.1')), '10.6.1');
    assert.equal(lineOfLabel(parseLabel('060：V10.6')), '10.6');
    assert.equal(lineOfLabel(parseLabel('060：010.6')), '010.6', 'the numbers are read as written; lineKey compares them');
    assert.equal(lineOfLabel(parseLabel('10.6.1')), null, 'no prefix code, no line node');
    assert.equal(lineOfLabel(parseLabel('060：10.6.1 专项')), null, 'the version is not the whole label');
    // The retired rule refused an address by meaning. The grammar reads a whole label of two to four dotted numbers, so a
    // dotted quad in a line position is the line its author named; renaming or declaring the form is the author's exit.
    assert.equal(lineOfLabel(parseLabel('060：192.0.2.10')), '192.0.2.10');
    assert.deepEqual(trainOfLabel(parseLabel('004：10.6.1-R2-2026/7')), { train: '10.6.1-R2-2026/7', version: '10.6.1' });
    assert.deepEqual(trainOfLabel(parseLabel('004：10.6.1_R2')), { train: '10.6.1_R2', version: '10.6.1' });
    assert.deepEqual(trainOfLabel(parseLabel('301：10.6.2 主线SY DEMOOS12-2026/08/02')), { train: '10.6.2 主线SY DEMOOS12-2026/08/02', version: '10.6.2' });
    assert.equal(trainOfLabel(parseLabel('10.7.3 迁移回归')), null, 'no prefix code');
    assert.equal(trainOfLabel(parseLabel('004：10.6.1-')), null, 'an empty suffix is not a train');
    assert.equal(trainOfLabel(parseLabel('004：10.6.1')), null, 'a line node is not a train');
    assert.deepEqual(trainOfLabel(parseLabel('004：10.6.1 专项 回归')), { train: '10.6.1 专项 回归', version: '10.6.1' });
    assert.deepEqual(trainOfLabel(parseLabel('101：192.0.2.10-网段')), { train: '192.0.2.10-网段', version: '192.0.2.10' }, 'syntax, not meaning');
  });

  it('takes any whole single-line label below a train as the module name', () => {
    const module = (label: string) => moduleOfLabel(parseLabel(label), hasIds);
    for (const [label, name] of [
      ['SSL', 'SSL'],
      ['000-001-002：HA', 'HA'],
      ['WebUI', 'WebUI'],
      ['系统', '系统'],
      ['TLS1.3 握手', 'TLS1.3 握手'],
      // The retired rule excluded activities, documents, versions, dates and ids by meaning. The declared layer reads any
      // whole single-line label, so a name that mentions 测试, bug or 回归 is the module its author wrote (R6).
      ['bug to case 61001', 'bug to case 61001'],
      ['61001-会话保持', '61001-会话保持'],
      ['回归测试', '回归测试'],
      ['需求 7001', '需求 7001'],
      ['10.6.1第二阶段测试', '10.6.1第二阶段测试'],
      ['9.9.9 迁移引用', '9.9.9 迁移引用'],
      ['build20260101', 'build20260101'],
      ['patch2 专项', 'patch2 专项'],
      ['2026/07 版本', '2026/07 版本'],
      ['x'.repeat(1000), 'x'.repeat(1000)],
    ]) {
      assert.equal(module(label), name, label);
    }
    // Not a module: no text, more than one line, or longer than the declared 1000 characters.
    assert.equal(module(''), null);
    assert.equal(module('SSL\n设置'), null);
    // A label is read at most MAX_LABEL characters: an over-long label gives the cut text, which is the identity the pack
    // can vouch for (real folder labels are far shorter, and the cut is part of the declaration).
    assert.equal(module('x'.repeat(1001)), 'x'.repeat(1000));
  });

  it('reads a label that is only a version in the declared form as a version label', () => {
    for (const [label, version] of [
      ['10.6.1', '10.6.1'],
      ['V10.7.0', '10.7.0'],
      ['v9.8', '9.8'],
      ['FAMY_10.7.3', '10.7.3'],
      ['FAMX-10.7.6', '10.7.6'],
      ['060：10.6.1', '10.6.1'],
      ['060：FAMY_10.6.1', '10.6.1'],
    ]) {
      assert.equal(pureVersionOf(parseLabel(label), NAMES), version, label);
    }
    // The name prefix is a declared name of the bound line, compared exactly: another word, another case or an unbound
    // name is not a version form (U23), and the layer stays unread instead of being guessed.
    for (const label of ['famy_10.7.3', 'OTHER_10.7.3', 'patch1.2', 'TLSv1.3', 'SSL3.0', 'build20260315', 'hotpatch2']) {
      assert.equal(pureVersionOf(parseLabel(label), NAMES), null, label);
    }
    assert.equal(pureVersionOf(parseLabel('famy_10.7.3'), ['famy']), '10.7.3', 'the bound names decide, exactly');
    // Not the whole label, or not the declared numeric form.
    for (const label of ['FAMY_10.6.1.57_专项', 'V10.7.0 专项测试', '802.1Q VLAN', 'Chrome 120.0 兼容', 'OpenSSL 1.1.1 升级', '10.6.1-R2-2026/7', '2026.06.30.1.2', '1234.5', '１０.６.１', '']) {
      assert.equal(pureVersionOf(parseLabel(label), NAMES), null, label);
    }
  });
});

describe('the version scheme', () => {
  it('reads only a whole label in the declared version form', () => {
    assert.deepEqual(scan('060：10.6.1'), [['version', '10.6.1']]);
    assert.deepEqual(scan('FAMY_10.7.3'), [['version', '10.7.3']]);
    assert.deepEqual(scan('V10.7.0'), [['version', '10.7.0']]);
    // The retired scheme read build dates and patch numbers in priority order and versions out of longer labels. Neither
    // is a declared form any more: a label that is not wholly a version gives nothing, and nothing is rejected for shape.
    for (const label of ['build20260315 回归', 'Build_20260315', 'patch2', 'Patch 1.2 专项', 'FAMY_10.7.3_patch3', 'FAMX 10.7.0 build20260110', '10.7.0-build20260402-2026/4', 'hotpatch2', 'V10.7.0 专项', '10.6.1-R2-2026/7']) {
      assert.deepEqual(scan(label), [], label);
      assert.deepEqual(schemeScan(parseLabel(label).rest, NAMES).rejects, [], label);
    }
    // Numbers outside the declared form (one part, five parts, an empty part) are not a version.
    for (const label of ['20260315', '1234.5', '10.6.1.2.3', '3.', '.5', '10.6.1.2.3.4']) {
      assert.deepEqual(scan(label).filter(([kind]) => kind === 'version'), [], label);
    }
  });

  it('reads two to four dotted numbers with an optional v, and a declared name prefix', () => {
    for (const [text, version] of [
      ['10.6.1', '10.6.1'],
      ['10.6', '10.6'],
      ['10.6.1.57', '10.6.1.57'],
      ['V10.7.0', '10.7.0'],
      ['v9.8', '9.8'],
      ['FAMX_10.7.6', '10.7.6'],
      ['FAMY-10.6.1.57', '10.6.1.57'],
    ]) {
      assert.equal(versionForm(text, NAMES), version, text);
      assert.deepEqual(schemeScan(text, NAMES).matches, [{ kind: 'version', value: version, start: 0, end: text.length }], text);
    }
    // An unbound name, a lower-cased name, two separators or no separator is outside the declaration.
    for (const text of ['R10.6.2', 'famy-10.6.1', 'FAMX__10.7.6', 'aFAMX10.7.6', '10.6.1.2.3.4', '1000.6.1']) {
      assert.equal(versionForm(text, NAMES), null, text);
    }
    // Without bound names (an unbound run) only the bare numeric form is read.
    assert.equal(versionForm('FAMY_10.7.3', []), null);
    assert.equal(versionForm('10.7.3', []), '10.7.3');
  });

  it('reads a whole label only: a version inside other words is not a version', () => {
    // The retired guards named protocol versions, quantities and addresses. The grammar needs none of them: it reads a
    // whole label or nothing, so a version mentioned inside words is simply not read.
    for (const label of ['TLSv1.3 握手', 'SSL3.0 兼容', 'HTTP/1.1 长连接', 'tls 1.2', 'DTLS1.2', 'TLS v1.3', '1.5倍压力', '0.5 秒超时', '2.5GB 内存', '12.5%', '192.0.2.10 地址测试', '192.0.2.0/24 网段', '192.0.2.7:8080', 'SSL 10.6.1 卸载', 'HTTPS 10.7.0 专项']) {
      assert.deepEqual(scan(label), [], label);
    }
    // A whole label of dotted numbers is a version whatever it also looks like: the syntax decides, and an address-shaped
    // folder is the author's naming to fix, not a word guard's to refuse.
    assert.equal(notAVersion('192.0.2.10', 0, 10, '192.0.2.10'), null);
    assert.equal(notAVersion('10.6.1 SSL', 0, 6, '10.6.1'), 'grammar', 'a version among other words is outside the grammar');
    assert.equal(notAVersion('10.6.1/24', 0, 6, '10.6.1'), 'grammar');
    assert.equal(versionForm('192.0.2.10', NAMES), '192.0.2.10');
  });
});

describe('version lines and build names', () => {
  it('compares lines as the product pack does, versions by dotted prefix and by their version line', () => {
    // U24 (owner, 2026-10-24): leading zeroes and a trailing .0 beyond the second part do not change the version line.
    assert.equal(lineKey('10.6.0'), '10.6');
    assert.equal(lineKey('010.6'), '10.6');
    assert.equal(lineKey('010.006.000'), '10.6');
    assert.equal(lineKey('V10.6.1'), '10.6.1');
    assert.equal(lineKey('10.6.1.0'), '10.6.1');
    assert.ok(versionsAgree('10.6', '10.6.1'));
    assert.ok(versionsAgree('10.6.1.57', '10.6.1'));
    assert.ok(versionsAgree('010.6', '10.6'));
    assert.ok(!versionsAgree('10.6.0', '10.6.1'));
    assert.ok(!versionsAgree('10.7.3', '10.6.1'));
    assert.equal(lineOfVersion('10.6.1.57'), '10.6.1');
    assert.equal(lineOfVersion('10.6'), '10.6');
    assert.ok(sameLine('10.6.1.57', '10.6.1'));
    assert.ok(sameLine('10.6.0', '10.6'));
    assert.ok(sameLine('010.6.1', '10.6.1'));
    assert.ok(!sameLine('10.6', '10.6.1'));
    assert.ok(!sameLine('9.8', '10.6'));
    assert.ok(!sameLine('10.6.2', '10.6.1'));
    // A non-zero digit differs: the writing of the line does not merge two lines.
    assert.ok(!sameLine('10.6.1', '10.6.2'));
    assert.notEqual(lineKey('10.6.1'), lineKey('10.7.0'));
  });

  it('finds a build name at the start of a label, as written', () => {
    // The declared scope of the build-name grammar is the label, not arbitrary prose: a name inside a sentence is not read.
    assert.deepEqual(buildNames('Rel_FAMY_10_6_1_57 回归，对比 Rel_FAMX-SY-K_10_6_1_8_4_129 和 Beta.FAMX.10.7.0.3').map((b) => b.name), ['Rel_FAMY_10_6_1_57']);
    assert.deepEqual(buildNames('Rel_FAMY_10_6_1_57').map((b) => [b.name, b.kind, b.separator, b.family, b.platform, b.numbers]), [['Rel_FAMY_10_6_1_57', 'Rel', '_', 'FAMY', '', '10_6_1_57']]);
    assert.deepEqual(buildNames('Rel_FAMX-SY-K_10_6_1_8_4_129').map((b) => [b.name, b.family, b.platform]), [['Rel_FAMX-SY-K_10_6_1_8_4_129', 'FAMX', '-SY-K']]);
    assert.deepEqual(buildNames('Beta.FAMX.10.7.0.3').map((b) => [b.name, b.kind, b.separator]), [['Beta.FAMX.10.7.0.3', 'Beta', '.']]);
    assert.deepEqual(buildNames('XRel_FAMX_10_6_1_57 Rel_FAMX_10'), []);
    assert.deepEqual(buildNames('对比 Rel_FAMY_10_6_1_57'), [], 'a name that does not start the label is not read');
  });

  it('lists only the written names of the line families, verbatim, and never makes one up', () => {
    const names = NAMES;
    // No twin in the other family (an older FAMY build is based on an FAMX build with another number).
    assert.deepEqual(writtenBuilds(['Rel_FAMY_10_9_1_37 回归'], names, 24), { names: ['Rel_FAMY_10_9_1_37'], foreign: [] });
    assert.deepEqual(writtenBuilds(['Rel_FAMX-SY-K_10_6_1_8_4_129'], names, 24), { names: ['Rel_FAMX-SY-K_10_6_1_8_4_129'], foreign: [] });
    // A family is compared exactly: a lower-cased name is another product's as far as the declaration goes (U23), and it
    // is reported, not folded into the bound family.
    assert.deepEqual(writtenBuilds(['Rel_OTHERPROD_9_1_0_3 对比', 'FAMY_10.6.1.57', 'Rel_famy_10_6_1_57', 'Rel_FAMY_10_6_1_57'], names, 24), { names: ['Rel_FAMY_10_6_1_57'], foreign: ['Rel_OTHERPROD_9_1_0_3', 'Rel_famy_10_6_1_57'] });
    // Without the names of a line (an unbound run) nothing is listed.
    assert.deepEqual(writtenBuilds(['Rel_FAMY_10_9_1_37'], [], 24), { names: [], foreign: ['Rel_FAMY_10_9_1_37'] });
    assert.equal(writtenBuilds([Array.from({ length: 40 }, (_, k) => `Rel_FAMX_10_6_1_${k}`).join(' ')], names, 5).names.length, 1, 'one label, one name at its start');
    assert.equal(writtenBuilds(Array.from({ length: 40 }, (_, k) => `Rel_FAMX_10_6_1_${k}`), names, 5).names.length, 5);
  });
});

it('build versions follow the product naming rule without importing it in the runtime pack', async () => {
  const { parseBuildName } = await import('../../../product/famx/functions/naming.ts');
  const { buildVersionsOf } = await import('./convention.ts');
  for (const name of ['Rel_FAMX_10_9_1_37', 'Beta_FAMY_10_8_42', 'Rel_FAMX_10_9', 'Rel_FAMX_010_009_001_037', 'Rel_FAMX_10_7_0_12']) {
    assert.equal(buildVersionsOf(parseLabel(`${name} 回归`), NAMES)[0].version, parseBuildName(name).line, name);
  }
});
