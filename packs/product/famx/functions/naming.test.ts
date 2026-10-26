import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathOf, selectorOf } from '../../../../hub/refs/api.ts';
import { compareLines, deviceSpelling, lineKey, parseBuildName, parseHubName, parsePageName, sameLine } from './naming.ts';
import { canonicalJson, compareDotted, globMatch, pathSegments, pathText, selectorText, utf8Offsets } from './util.ts';
import { randomText, seeded } from '../testing/test-support.ts';

function orNull(run: () => string): string | null {
  try {
    return run();
  } catch {
    return null;
  }
}

describe('build names', () => {
  it('reads family, platform, line and number of both name families', () => {
    assert.deepEqual(parseBuildName('Rel_FAMX_10_6_1_57'), { family: 'FAMX', platform: null, line: '10.6.1', number: '57', variant: null });
    assert.deepEqual(parseBuildName('Rel_FAMY_10_6_1_41'), { family: 'FAMY', platform: null, line: '10.6.1', number: '41', variant: null });
    assert.deepEqual(parseBuildName('Rel_FAMX-SY-K_10_6_1_3_1_9'), { family: 'FAMX', platform: 'sy-k', line: '10.6.1', number: '3.1.9', variant: null });
    assert.deepEqual(parseBuildName('BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click'), {
      family: 'FAMY',
      platform: 'sy-k',
      line: '10.6.1',
      number: '3.2.7',
      variant: 'BrandOS-*.click',
    });
    assert.deepEqual(parseBuildName('Beta_FAMX_10_7_0_101'), { family: 'FAMX', platform: null, line: '10.7.0', number: '101', variant: null });
    assert.deepEqual(parseBuildName('Rel.FAMX-SY-U.10.6.1.3.patch.p1'), { family: 'FAMX', platform: 'sy-u', line: '10.6.1', number: '3', variant: '*.patch.p1' });
    assert.deepEqual(parseBuildName('trial-Rel_Famy_9_2_1_7.click'), { family: 'FAMY', platform: null, line: '9.2.1', number: '7', variant: 'trial-*.click' });
    assert.deepEqual(parseBuildName('Rel_OTHER_3_9_1_2'), { family: 'other', platform: null, line: '3.9.1', number: '2', variant: null });
  });

  it('handles short names and rejects others without throwing', () => {
    assert.deepEqual(parseBuildName('Rel_FAMX_10_7_12'), { family: 'FAMX', platform: null, line: '10.7', number: '12', variant: null });
    assert.deepEqual(parseBuildName('Rel_FAMX_10_7'), { family: 'FAMX', platform: null, line: '10.7', number: null, variant: null });
    for (const name of ['', 'Rel_FAMX', 'Release_FAMX_10_6_1', 'FAMX_10_6_1_57', 'Rel_FAMX_x_y', '中文构建', 'Rel_FAMX_10'.repeat(80)]) {
      const parts = parseBuildName(name);
      assert.equal(parts.line, null, name);
      assert.equal(parts.family, 'other', name);
    }
    assert.equal(parseBuildName(5 as unknown as string).family, 'other');
  });

  it('drops leading zeros so numbers compare by value', () => {
    assert.equal(parseBuildName('Rel_FAMX_010_06_01_007').line, '10.6.1');
    assert.equal(parseBuildName('Rel_FAMX_010_06_01_007').number, '7');
    assert.ok(compareDotted('3.1.29', '3.1.4') > 0);
    assert.ok(compareDotted('57', '9') > 0);
    assert.ok(compareDotted('8.4', '8.4.1') < 0);
    assert.ok(compareDotted(null, '1') < 0);
  });
});

describe('version lines', () => {
  it('treats 10.6, 10.6.0 and 010.6 as one line and keeps others apart', () => {
    assert.equal(lineKey('10.6.0'), '10.6');
    assert.equal(lineKey('010.6'), '10.6');
    // No folding: a value written with spaces is not the declared numeric form, and is kept exactly as written.
    assert.equal(lineKey(' 10.6.1 '), ' 10.6.1 ');
    assert.equal(lineKey('10.6.100'), '10.6.100');
    assert.ok(sameLine('10.6', '10.6.0'));
    assert.ok(!sameLine('10.6.1', '10.6'));
    assert.ok(!sameLine(null, '10.6'));
    // U24 normalizes only what the owner declared (leading zeroes, a trailing .0); case is not folded, so a qualifier
    // written in another case is another line identity.
    assert.equal(lineKey('10.6.DEMOQUALIFIER'), '10.6.DEMOQUALIFIER');
    assert.ok(!sameLine('10.6.DEMOQUALIFIER', '10.6.demoqualifier'));
  });

  it('orders lines numerically', () => {
    const lines = ['10.6.10', '9.2', '10.6.2', '10.6', 'x', '10.6.1'];
    assert.deepEqual([...lines].sort(compareLines), ['9.2', '10.6', '10.6.1', '10.6.2', '10.6.10', 'x']);
  });
});

describe('listing page names', () => {
  it('classifies mainline, platform, customer and patch pages of both families', () => {
    const cases: Array<[string, ReturnType<typeof parsePageName>]> = [
      ['rel_famx_10_6', { family: 'FAMX', line: '10.6', platform: null, kind: 'mainline', tokens: ['rel', 'famx', '10', '6'] }],
      ['rel_famy_10_6_1', { family: 'FAMY', line: '10.6.1', platform: null, kind: 'mainline', tokens: ['rel', 'famy', '10', '6', '1'] }],
      ['rel_famx_10_6_demoqualifier', { family: 'FAMX', line: '10.6', platform: null, kind: 'mainline', tokens: ['rel', 'famx', '10', '6', 'demoqualifier'] }],
      // famx-pages@1: no fallback customer kind. A tail that is neither a declared mainline word, a whole `patch` token
      // nor `customer_<identifier>` is not a declared page form.
      ['famx_10_6_2_special', null],
      ['rel_famx_10_6_1_customer_examplebank', { family: 'FAMX', line: '10.6.1', platform: null, kind: 'customer', tokens: ['rel', 'famx', '10', '6', '1', 'customer', 'examplebank'] }],
      ['rel_famx_10_6_1_patch2', { family: 'FAMX', line: '10.6.1', platform: null, kind: 'patch', tokens: ['rel', 'famx', '10', '6', '1', 'patch2'] }],
      ['rel_famx_10_6_1_patchwork', null],
      ['rel_famx_10_6_1_sy_demoos12', { family: 'FAMX', line: '10.6.1', platform: 'sy-demoos12', kind: 'platform', tokens: ['rel', 'famx', '10', '6', '1', 'sy', 'demoos12'] }],
      ['rel_famy_10_6_1_sz_demoos10', { family: 'FAMY', line: '10.6.1', platform: 'sz-demoos10', kind: 'platform', tokens: ['rel', 'famy', '10', '6', '1', 'sz', 'demoos10'] }],
      ['rel_famx_10_6_1_zx_demoos11', { family: 'FAMX', line: '10.6.1', platform: 'zx-demoos11', kind: 'platform', tokens: ['rel', 'famx', '10', '6', '1', 'zx', 'demoos11'] }],
      ['rel_famx_10_6_1_examplebank_poc', null],
      ['rel_famx_10_6_1_45', null],
      ['rel_famx-sy-u_10_6_1_24_tenantx', null],
      [
        'rel_famx_10_6_0_100_1_1_examplebank_patch',
        { family: 'FAMX', line: '10.6.0', platform: null, kind: 'patch', tokens: ['rel', 'famx', '10', '6', '0', '100', '1', '1', 'examplebank', 'patch'] },
      ],
      ['rel_other_3_9', { family: 'other', line: '3.9', platform: null, kind: 'mainline', tokens: ['rel', 'other', '3', '9'] }],
    ];
    for (const [name, expected] of cases) assert.deepEqual(parsePageName(name,['demoqualifier']), expected, name);
  });

  it('rejects names that are not listing pages of a version', () => {
    for (const name of ['famx_trunk', 'famx_10_x_old_builds', 'famx_10_6_2', 'famy_10_6', 'afamx10_6_docker', 'builder_trunk_sy_demoos12', 'other_3_9', 'rel_10_6', '', 'rel_famx', 'x'.repeat(300)]) {
      assert.equal(parsePageName(name), null, name);
    }
  });
});

describe('hub page names', () => {
  it('names a hub page: a product name without rel_, then only a version or no version at all', () => {
    const cases: Array<[string, ReturnType<typeof parseHubName>]> = [
      ['famx_10_6_2', { family: 'FAMX', line: '10.6.2', tokens: ['famx', '10', '6', '2'] }],
      ['famx_10_6', { family: 'FAMX', line: '10.6', tokens: ['famx', '10', '6'] }],
      ['FAMY_10_6_0', { family: 'FAMY', line: '10.6.0', tokens: ['famy', '10', '6', '0'] }],
      ['famx_trunk', { family: 'FAMX', line: null, tokens: ['famx', 'trunk'] }],
      ['famx_10_x_old_builds', { family: 'FAMX', line: null, tokens: ['famx', '10', 'x', 'old', 'builds'] }],
    ];
    for (const [name, expected] of cases) assert.deepEqual(parseHubName(name), expected, name);
  });

  it('never takes a listing page or another name for a hub', () => {
    for (const name of ['rel_famx_10_6_2', 'rel_famy_10_6', 'famx_10_6_2_special', 'famx_10_6_sy_k', 'afamx10_6_docker', 'other_10_6', 'demostack_10_6_2_special', '', 'x'.repeat(300)]) {
      assert.equal(parseHubName(name), null, name);
    }
  });
});

describe('codecs and glob', () => {
  it('writes canonical selector and path text like hub/refs', () => {
    assert.equal(selectorText(['x', 'commands', 'menu[2]']), 'x/commands/menu[2]');
    assert.equal(selectorText(['x', 'a:b', 'c d']), 'x/a%3Ab/c%20d');
    assert.equal(selectorText(['x', '']), null);
    assert.equal(selectorText(['x', '\ud800']), null);
    assert.equal(pathText(['commands', 'show', 'a/b@c', '?']), '/commands/show/a%2Fb%40c/?');
    assert.equal(pathText([]), '/');
    assert.equal(pathText(['50%']), '/50%25');
  });

  it('agrees with hub/refs selectorOf and pathOf on random segments', () => {
    const random = seeded(11);
    for (let i = 0; i < 2000; i++) {
      const segments = Array.from({ length: 1 + random.int(4) }, () => randomText(random, 12));
      assert.equal(selectorText(segments), orNull(() => selectorOf(segments)), JSON.stringify(segments));
      const path = pathText(segments);
      assert.equal(path, orNull(() => pathOf(segments)), JSON.stringify(segments));
      if (path !== null) assert.deepEqual(pathSegments(path), segments);
    }
  });

  it('computes UTF-8 offsets like an encoder, unpaired surrogates as three bytes', () => {
    const random = seeded(19);
    for (let i = 0; i < 500; i++) {
      const text = randomText(random, 40);
      const offsets = utf8Offsets(text);
      assert.equal(offsets[text.length], Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
      for (let k = 0; k <= text.length; k++) {
        const inPair = k > 0 && /[\ud800-\udbff]/.test(text[k - 1]) && /[\udc00-\udfff]/.test(text[k] ?? '');
        if (!inPair) assert.equal(offsets[k], Buffer.byteLength(text.slice(0, k), 'utf8'), `${JSON.stringify(text)} at ${k}`);
      }
    }
  });

  it('writes canonical JSON: keys sorted at every level, undefined left out, cycles named', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, undefined, { f: null, e: 'x' }], c: undefined } }), '{"a":{"d":[3,null,{"e":"x","f":null}]},"b":1}');
    assert.equal(canonicalJson({ y: 1, x: 2 }), canonicalJson({ x: 2, y: 1 }));
    const cyclic: { [key: string]: unknown } = { name: 'x' };
    cyclic.self = cyclic;
    assert.equal(canonicalJson(cyclic), '{"name":"x","self":"[cycle]"}');
    assert.equal(canonicalJson([1, 'a', true, null]), JSON.stringify([1, 'a', true, null]));
  });

  it('matches globs over whole names, case-insensitively', () => {
    assert.ok(globMatch('rel_famx_*_sy_k', 'REL_FAMX_10_6_1_2_SY_K'));
    assert.ok(globMatch('*', ''));
    assert.ok(globMatch('rel_?amy_*', 'rel_famy_10_6'));
    assert.ok(!globMatch('rel_famx_*', 'rel_famy_10_6'));
    assert.ok(!globMatch('*_sy_k', 'rel_famx_10_6_sy_demoos12'));
    const random = seeded(7);
    for (let i = 0; i < 300; i++) {
      const text = randomText(random, 30);
      assert.ok(globMatch('*', text));
      assert.equal(globMatch(text.replaceAll('*', '').replaceAll('?', ''), text.replaceAll('*', '').replaceAll('?', '')), true);
    }
  });
});

describe('the device display spelling (C07 R[9] identity rule of this pack)', () => {
  it('is the one declared replacement of every _ with a dot, and parses to the same build', () => {
    assert.equal(deviceSpelling('Beta_FAMX-ZX-U_10_8_0_901'), 'Beta.FAMX-ZX-U.10.8.0.901');
    assert.deepEqual(parseBuildName(deviceSpelling('Beta_FAMX-ZX-U_10_8_0_901')), parseBuildName('Beta_FAMX-ZX-U_10_8_0_901'));
    assert.equal(deviceSpelling('Rel_FAMX_10_8'), 'Rel.FAMX.10.8');
  });
  it('does nothing else: case is kept, no separator is invented, no prefix is stripped', () => {
    assert.equal(deviceSpelling('Beta_famx-ZX-U_10_8_0_901'), 'Beta.famx-ZX-U.10.8.0.901');
    assert.equal(deviceSpelling('Rel-FAMX_10_8'), 'Rel-FAMX.10.8');
    assert.equal(deviceSpelling('Vendor Beta.FAMX-ZX-U.10.8.0.901'), 'Vendor Beta.FAMX-ZX-U.10.8.0.901');
  });
  it('is never equal to a build-site spelling that has a separator, so the alias never shadows the build', () => {
    for (const name of ['Beta_FAMX-ZX-U_10_8_0_901', 'Rel_FAMX_10_8', 'Rel_FAMY_10_8']) assert.notEqual(deviceSpelling(name), name);
  });
});
