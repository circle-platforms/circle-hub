import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathOf, selectorOf } from '../../../../hub/refs/api.ts';
import { compareLines, lineKey, parseBuildName, parseHubName, parsePageName, sameLine } from './naming.ts';
import { canonicalJson, compareDotted, globMatch, pathSegments, pathText, selectorText, utf8Offsets } from './util.ts';
import { randomText, seeded } from './test-support.ts';

function orNull(run: () => string): string | null {
  try {
    return run();
  } catch {
    return null;
  }
}

describe('build names', () => {
  it('reads family, platform, line and number of both name families', () => {
    assert.deepEqual(parseBuildName('Rel_APV_10_6_1_57'), { family: 'APV', platform: null, line: '10.6.1', number: '57', variant: null });
    assert.deepEqual(parseBuildName('Rel_NSAE_10_6_1_41'), { family: 'NSAE', platform: null, line: '10.6.1', number: '41', variant: null });
    assert.deepEqual(parseBuildName('Rel_APV-HG-K_10_6_1_3_1_9'), { family: 'APV', platform: 'hg-k', line: '10.6.1', number: '3.1.9', variant: null });
    assert.deepEqual(parseBuildName('BrandOS-Rel_NSAE-HG-K_10_6_1_3_2_7.click'), {
      family: 'NSAE',
      platform: 'hg-k',
      line: '10.6.1',
      number: '3.2.7',
      variant: 'BrandOS-*.click',
    });
    assert.deepEqual(parseBuildName('Beta_APV_10_7_0_101'), { family: 'APV', platform: null, line: '10.7.0', number: '101', variant: null });
    assert.deepEqual(parseBuildName('Rel.APV-HG-U.10.6.1.3.patch.p1'), { family: 'APV', platform: 'hg-u', line: '10.6.1', number: '3', variant: '*.patch.p1' });
    assert.deepEqual(parseBuildName('trial-Rel_Nsae_9_2_1_7.click'), { family: 'NSAE', platform: null, line: '9.2.1', number: '7', variant: 'trial-*.click' });
    assert.deepEqual(parseBuildName('Rel_OTHER_3_9_1_2'), { family: 'other', platform: null, line: '3.9.1', number: '2', variant: null });
  });

  it('handles short names and rejects others without throwing', () => {
    assert.deepEqual(parseBuildName('Rel_APV_10_7_12'), { family: 'APV', platform: null, line: '10.7', number: '12', variant: null });
    assert.deepEqual(parseBuildName('Rel_APV_10_7'), { family: 'APV', platform: null, line: '10.7', number: null, variant: null });
    for (const name of ['', 'Rel_APV', 'Release_APV_10_6_1', 'APV_10_6_1_57', 'Rel_APV_x_y', '中文构建', 'Rel_APV_10'.repeat(80)]) {
      const parts = parseBuildName(name);
      assert.equal(parts.line, null, name);
      assert.equal(parts.family, 'other', name);
    }
    assert.equal(parseBuildName(5 as unknown as string).family, 'other');
  });

  it('drops leading zeros so numbers compare by value', () => {
    assert.equal(parseBuildName('Rel_APV_010_06_01_007').line, '10.6.1');
    assert.equal(parseBuildName('Rel_APV_010_06_01_007').number, '7');
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
    assert.equal(lineKey(' 10.6.1 '), '10.6.1');
    assert.equal(lineKey('10.0.0'), '10.0');
    assert.ok(sameLine('10.6', '10.6.0'));
    assert.ok(!sameLine('10.6.1', '10.6'));
    assert.ok(!sameLine(null, '10.6'));
    assert.equal(lineKey('10.6.TLS1.3'), '10.6.tls1.3');
  });

  it('orders lines numerically', () => {
    const lines = ['10.6.10', '9.2', '10.6.2', '10.6', 'x', '10.6.1'];
    assert.deepEqual([...lines].sort(compareLines), ['9.2', '10.6', '10.6.1', '10.6.2', '10.6.10', 'x']);
  });
});

describe('listing page names', () => {
  it('classifies mainline, platform, customer and patch pages of both families', () => {
    const cases: Array<[string, ReturnType<typeof parsePageName>]> = [
      ['rel_apv_10_6', { family: 'APV', line: '10.6', platform: null, kind: 'mainline', tokens: ['rel', 'apv', '10', '6'] }],
      ['rel_nsae_10_6_1', { family: 'NSAE', line: '10.6.1', platform: null, kind: 'mainline', tokens: ['rel', 'nsae', '10', '6', '1'] }],
      ['rel_apv_10_6_tls13', { family: 'APV', line: '10.6', platform: null, kind: 'mainline', tokens: ['rel', 'apv', '10', '6', 'tls13'] }],
      ['apv_10_6_2_special', { family: 'APV', line: '10.6.2', platform: null, kind: 'customer', tokens: ['apv', '10', '6', '2', 'special'] }],
      ['rel_apv_10_6_1_hg_uos', { family: 'APV', line: '10.6.1', platform: 'hg-uos', kind: 'platform', tokens: ['rel', 'apv', '10', '6', '1', 'hg', 'uos'] }],
      ['rel_nsae_10_6_1_ft_kylinv10', { family: 'NSAE', line: '10.6.1', platform: 'ft-kylinv10', kind: 'platform', tokens: ['rel', 'nsae', '10', '6', '1', 'ft', 'kylinv10'] }],
      ['rel_apv_10_6_1_zx_neokylin', { family: 'APV', line: '10.6.1', platform: 'zx-neokylin', kind: 'platform', tokens: ['rel', 'apv', '10', '6', '1', 'zx', 'neokylin'] }],
      ['rel_apv_10_6_1_examplebank_poc', { family: 'APV', line: '10.6.1', platform: null, kind: 'customer', tokens: ['rel', 'apv', '10', '6', '1', 'examplebank', 'poc'] }],
      ['rel_apv_10_6_1_45', { family: 'APV', line: '10.6.1', platform: null, kind: 'customer', tokens: ['rel', 'apv', '10', '6', '1', '45'] }],
      ['rel_apv-hg-u_10_6_1_24_tenantx', { family: 'APV', line: '10.6.1', platform: 'hg-u', kind: 'customer', tokens: ['rel', 'apv', 'hg', 'u', '10', '6', '1', '24', 'tenantx'] }],
      [
        'rel_apv_10_6_0_100_1_1_examplebank_patch',
        { family: 'APV', line: '10.6.0', platform: null, kind: 'patch', tokens: ['rel', 'apv', '10', '6', '0', '100', '1', '1', 'examplebank', 'patch'] },
      ],
      ['rel_other_3_9', { family: 'other', line: '3.9', platform: null, kind: 'mainline', tokens: ['rel', 'other', '3', '9'] }],
    ];
    for (const [name, expected] of cases) assert.deepEqual(parsePageName(name), expected, name);
  });

  it('rejects names that are not listing pages of a version', () => {
    for (const name of ['apv_trunk', 'apv_10_x_old_builds', 'apv_10_6_2', 'nsae_10_6', 'apv10_6_docker', 'builder_trunk_hg_uos', 'other_3_9', 'rel_10_6', '', 'rel_apv', 'x'.repeat(300)]) {
      assert.equal(parsePageName(name), null, name);
    }
  });
});

describe('hub page names', () => {
  it('names a hub page: a product name without rel_, then only a version or no version at all', () => {
    const cases: Array<[string, ReturnType<typeof parseHubName>]> = [
      ['apv_10_6_2', { family: 'APV', line: '10.6.2', tokens: ['apv', '10', '6', '2'] }],
      ['apv_10_6', { family: 'APV', line: '10.6', tokens: ['apv', '10', '6'] }],
      ['NSAE_10_6_0', { family: 'NSAE', line: '10.6.0', tokens: ['nsae', '10', '6', '0'] }],
      ['apv_trunk', { family: 'APV', line: null, tokens: ['apv', 'trunk'] }],
      ['apv_10_x_old_builds', { family: 'APV', line: null, tokens: ['apv', '10', 'x', 'old', 'builds'] }],
    ];
    for (const [name, expected] of cases) assert.deepEqual(parseHubName(name), expected, name);
  });

  it('never takes a listing page or another name for a hub', () => {
    for (const name of ['rel_apv_10_6_2', 'rel_nsae_10_6', 'apv_10_6_2_special', 'apv_10_6_hg_k', 'apv10_6_docker', 'other_10_6', 'demostack_10_6_2_special', '', 'x'.repeat(300)]) {
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
    assert.ok(globMatch('rel_apv_*_hg_k', 'REL_APV_10_6_1_2_HG_K'));
    assert.ok(globMatch('*', ''));
    assert.ok(globMatch('rel_?sae_*', 'rel_nsae_10_6'));
    assert.ok(!globMatch('rel_apv_*', 'rel_nsae_10_6'));
    assert.ok(!globMatch('*_hg_k', 'rel_apv_10_6_hg_uos'));
    const random = seeded(7);
    for (let i = 0; i < 300; i++) {
      const text = randomText(random, 30);
      assert.ok(globMatch('*', text));
      assert.equal(globMatch(text.replaceAll('*', '').replaceAll('?', ''), text.replaceAll('*', '').replaceAll('?', '')), true);
    }
  });
});
