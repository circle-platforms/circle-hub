import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import listing, { parseListing } from './listing.ts';
import type { Build, HtmlModel } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, html, internalWarnings, latin1, seeded } from '../testing/test-support.ts';

const famx = parseListing(html(fixtureBytes('listing-famx.html')));
const famy = parseListing(html(fixtureBytes('listing-famy.html')));
const byName = (builds: Build[], name: string): Build => {
  const found = builds.find((build) => build.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
};

describe('listing page of the FAMX family', () => {
  it('reads every entry in page order, a duplicate once', () => {
    assert.deepEqual(
      famx.builds.map((build) => build.name),
      [
        'Rel_FAMX_10_6_1_57',
        'Rel_FAMX_10_6_1_56',
        'Rel_FAMX_10_6_1_55',
        'Rel_FAMX_10_6_1_54',
        'Rel_FAMX_10_6_1_50',
        'Beta_FAMX_10_6_1_120',
        'Rel_FAMX_10_6_1_40',
        'Rel_FAMX_10_6_1_38',
        'Rel_FAMX_10_6_1_37',
        'Rel_FAMX_10_6_1_36',
      ],
    );
  });

  it('reads a released entry with its four files', () => {
    assert.deepEqual(byName(famx.builds, 'Rel_FAMX_10_6_1_57'), {
      name: 'Rel_FAMX_10_6_1_57',
      family: 'FAMX',
      platform: null,
      line: '10.6.1',
      number: '57',
      built: '2026-05-12T10:20:30',
      released: '2026-05-14',
      basedOn: null,
      files: {
        image: {
          name: 'DemoOS-Rel_FAMX_10_6_1_57.array',
          href: '/builds/DemoOS-Rel_FAMX_10_6_1_57.array',
          size: '901M',
          sha256: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
        },
        mib: { name: 'DEMO-MIB-Rel_FAMX_10_6_1_57.txt', href: '/builds/DEMO-MIB-Rel_FAMX_10_6_1_57.txt' },
        commandTree: { name: 'command_tree-Rel_FAMX_10_6_1_57.xml', href: '/builds/command_tree-Rel_FAMX_10_6_1_57.xml' },
        bugsFixed: { name: 'Bugs_Fixed_with_Rel_FAMX_10_6_1_57.html', href: '/builds/Bugs_Fixed_with_Rel_FAMX_10_6_1_57.html' },
        other: [{ name: 'DEMO-MIB_cn-Rel_FAMX_10_6_1_57.txt', href: '/builds/DEMO-MIB_cn-Rel_FAMX_10_6_1_57.txt' }],
      },
    });
  });

  it('keeps unreleased entries with an MD5 digest and no release date', () => {
    const build = byName(famx.builds, 'Rel_FAMX_10_6_1_56');
    assert.equal(build.released, null);
    assert.equal(build.built, '2026-05-10T09:00:00');
    assert.deepEqual(build.files.image, { name: 'DemoOS-Rel_FAMX_10_6_1_56.array', href: '/builds/DemoOS-Rel_FAMX_10_6_1_56.array', size: '899M', md5: '00112233445566778899aabbccddeeff' });
  });

  it('keeps the later of two listings of one build and warns', () => {
    const build = byName(famx.builds, 'Rel_FAMX_10_6_1_55');
    assert.equal(build.built, '2026-05-04T21:30:00');
    assert.equal(build.files.image?.sha256, 'bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00');
    assert.ok(famx.warnings.some((warning) => warning.includes('Rel_FAMX_10_6_1_55 列了两次') && warning.includes('2026-05-02T08:00:00')));
  });

  it('tolerates tabs and NBSP around the build time', () => {
    const build = byName(famx.builds, 'Rel_FAMX_10_6_1_54');
    assert.equal(build.built, '2026-04-28T17:45:01');
    assert.equal(build.released, '2026-04-30');
  });

  it('records a month-only release date, the remark and files named after another build', () => {
    const build = byName(famx.builds, 'Rel_FAMX_10_6_1_50');
    assert.equal(build.released, '2026-03');
    assert.equal(build.note, '(files of Rel_FAMX_10_6_1_49_1, see rel_famx_10_6_1_49_update.html)');
    assert.equal(build.files.commandTree?.name, 'command_tree-Rel_FAMX_10_6_1_49_1.xml');
    assert.ok(famx.warnings.some((warning) => warning.includes('只写到月份')));
    assert.ok(famx.warnings.some((warning) => warning.includes('command_tree-Rel_FAMX_10_6_1_49_1.xml 不含构建名')));
  });

  it('does not attach a page note on the same line to the next build', () => {
    const build = byName(famx.builds, 'Beta_FAMX_10_6_1_120');
    assert.equal(build.note, undefined);
    assert.equal(build.released, null);
    assert.equal(build.files.image?.md5, 'ffeeddccbbaa99887766554433221100');
  });

  it('cross-checks the red font against the release date', () => {
    assert.equal(byName(famx.builds, 'Rel_FAMX_10_6_1_38').released, null);
    assert.ok(famx.warnings.some((warning) => warning.includes('Rel_FAMX_10_6_1_38 有红色标注，但没有写发布日期')));
    assert.equal(byName(famx.builds, 'Rel_FAMX_10_6_1_37').released, '2025-12-31');
    assert.ok(famx.warnings.some((warning) => warning.includes('Rel_FAMX_10_6_1_37 有发布日期，但不在红色标注里')));
  });

  it('keeps an entry with an impossible build time, without the time', () => {
    const build = byName(famx.builds, 'Rel_FAMX_10_6_1_36');
    assert.equal(build.built, null);
    assert.ok(famx.warnings.some((warning) => warning.includes('Rel_FAMX_10_6_1_36 的构建时间认不出')));
  });

  it('reads the quoted and the unquoted href exactly as written', () => {
    assert.equal(byName(famx.builds, 'Rel_FAMX_10_6_1_40').files.image?.href, '/builds/DemoOS-Rel_FAMX_10_6_1_40.array');
    assert.equal(byName(famx.builds, 'Rel_FAMX_10_6_1_40').files.bugsFixed?.href, '/builds/Bugs_Fixed_with_Rel_FAMX_10_6_1_40.html');
  });
});

describe('listing page of the FAMY family', () => {
  it('reads based-on aliases without command trees, numbers that differ from the base', () => {
    assert.deepEqual(
      famy.builds.map((build) => [build.name, build.family, build.basedOn, build.released, build.files.commandTree === undefined]),
      [
        ['Rel_FAMY_10_6_1_41', 'FAMY', 'Rel_FAMX_10_6_1_57', '2026-05-22', true],
        ['Rel_FAMY_10_6_1_40', 'FAMY', 'Rel_FAMX_10_6_1_56', null, true],
        ['Rel_FAMY_10_6_1_33', 'FAMY', 'Rel_FAMX_10_6_1_54', '2026-05-06', true],
        ['Rel_FAMY_10_6_1_30', 'FAMY', 'Rel_FAMX_10_6_1_52', '2026-04-03', true],
        ['BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click', 'FAMY', 'Rel_FAMX-SY-K_10_6_1_3_1_9', '2026-05-27', true],
        ['Rel_FAMY_10_6_1_12', 'FAMY', null, '2025-10-10', true],
      ],
    );
    assert.deepEqual(famy.warnings, []);
  });

  it('reads platform tokens and variants from the name', () => {
    const build = byName(famy.builds, 'BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click');
    assert.equal(build.platform, 'sy-k');
    assert.equal(build.line, '10.6.1');
    assert.equal(build.number, '3.2.7');
    assert.equal(build.variant, 'BrandOS-*.click');
    assert.equal(build.files.image?.name, 'BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click');
    assert.equal(build.files.image?.size, '1.2G');
  });
});

describe('listing context, encodings and odd models', () => {
  it('takes the page platform for names without a platform token, never over the name', () => {
    const page = `<font color=red>Rel_FAMX_10_6_1_9 (build on 2026-01-01 01:02:03 ): Released on 2026-01-02</font><br><blockquote><a href=t.xml>command_tree-Rel_FAMX_10_6_1_9.xml</a></blockquote>
      Rel_FAMX-SZ-K_10_6_1_9 (build on 2026-01-01 01:02:03 ):<br>`;
    const result = listing({ model: html(page), context: { platform: 'SZ-Demoos10' } });
    assert.deepEqual(
      result.builds.map((build) => [build.name, build.platform]),
      [
        ['Rel_FAMX_10_6_1_9', 'sz-demoos10'],
        ['Rel_FAMX-SZ-K_10_6_1_9', 'sz-k'],
      ],
    );
  });

  it('decodes an ISO-8859-1 page and reads a red span written with style', () => {
    const page = latin1(
      '<html><head><meta charset="iso-8859-1"></head><body>Build Packages © 2026<br><span style="color: red">Rel_FAMY_9_2_1_3 (build on 2025-02-03 04:05:06 ): Released on 2025-02-04</span></body></html>',
    );
    const result = parseListing(html(page));
    assert.equal(result.builds.length, 1);
    assert.equal(result.builds[0].released, '2025-02-04');
    assert.deepEqual(result.warnings, []);
  });

  it('accepts a hand-made model without runs', () => {
    const model = {
      charset: 'utf-8',
      title: null,
      blocks: [{ tag: 'body', text: 'Rel_FAMX_9_2_1_4 (build on 2025-03-01 ): based on Rel_FAMX_9_2_1_3. Released on 2025/03/02', flags: [], links: [0], range: null }],
      links: [{ href: 'command_tree-Rel_FAMX_9_2_1_4.xml', text: 'tree', block: 0, wrappers: [], range: null }],
    };
    const result = parseListing(model as unknown as HtmlModel);
    assert.equal(result.builds.length, 1);
    assert.deepEqual([result.builds[0].built, result.builds[0].released, result.builds[0].basedOn], ['2025-03-01', '2025-03-02', 'Rel_FAMX_9_2_1_3']);
    assert.equal(result.builds[0].files.commandTree?.href, 'command_tree-Rel_FAMX_9_2_1_4.xml');
  });

  it('reads a release date only when it is complete, never a truncated one', () => {
    const lines = [
      ['Rel_FAMX_9_2_1_11', 'Released on 2026-03-1', null],
      ['Rel_FAMX_9_2_1_12', 'Released on 2026-3-1x', null],
      ['Rel_FAMX_9_2_1_13', 'Released on 2026-03-', null],
      ['Rel_FAMX_9_2_1_14', 'Released on 2025/3/2', null],
      ['Rel_FAMX_9_2_1_15', 'Released on 2026-03-14x', null],
      ['Rel_FAMX_9_2_1_16', 'Released on 2026-03-xx', '2026-03'],
      ['Rel_FAMX_9_2_1_17', 'Released on 2026-03-14, see notes', '2026-03-14'],
      ['Rel_FAMX_9_2_1_18', 'Released on 2026/03/14', '2026-03-14'],
    ] as const;
    const page = lines.map(([name, release]) => `<p><font color=red>${name} (build on 2026-03-01 10:00:00 ): ${release}</font></p>`).join('');
    const result = parseListing(html(page));
    assert.deepEqual(
      result.builds.map((build) => [build.name, build.released]),
      lines.map(([name, , released]) => [name, released]),
    );
    for (const [name, , released] of lines) {
      const unreadable = result.warnings.some((warning) => warning.includes(`构建 ${name} 写了 Released on，但发布日期认不出`));
      assert.equal(unreadable, released === null, name);
    }
    assert.ok(result.warnings.some((warning) => warning.includes('Rel_FAMX_9_2_1_16 的发布日期只写到月份')));
    assert.ok(!result.warnings.some((warning) => warning.includes('Rel_FAMX_9_2_1_13 的发布日期只写到月份')), 'a truncated date is not a month-only date');
    assert.equal(result.builds.find((build) => build.name === 'Rel_FAMX_9_2_1_17')?.note, ', see notes');
  });

  it('reads a line of very many links in linear time', () => {
    const model = html(`Rel_FAMX_9_2_1_5 (build on 2026-01-01 10:00:00 ): Released on 2026-01-02 ${'<a href=command_tree-Rel_FAMX_9_2_1_5.xml>t</a>'.repeat(200000)}`);
    const start = performance.now();
    const result = parseListing(model);
    const ms = performance.now() - start;
    assert.equal(result.builds.length, 1);
    assert.equal(result.builds[0].files.commandTree?.name, 'command_tree-Rel_FAMX_9_2_1_5.xml');
    assert.ok(ms < 1500, `took ${ms} ms`);
  });

  it('says when a page has no build entry but links pages: it is a hub page', () => {
    const hub = parseListing(html(fixtureBytes('hub-famx_10_6_2.html')));
    assert.deepEqual([hub.builds.length, hub.hub], [0, true]);
    assert.ok(hub.warnings.some((warning) => warning.includes('没有构建条目') && warning.includes('导航页')));
    assert.equal(famx.hub, false);
    assert.equal(parseListing(html('<p>nothing here</p>')).hub, false);
  });

  it('reports entries it cannot read instead of inventing them', () => {
    const result = parseListing(html('<p>（build on 2026-01-01）</p><p>中文 (build on 2026-01-01): x</p><p>Rel_FAMX_9_2_1_5 (build on 2026-01-01</p><a href=x.html>x</a>'));
    assert.deepEqual(result.builds.map((build) => [build.name, build.built]), [['Rel_FAMX_9_2_1_5', null]]);
    assert.ok(result.warnings.some((warning) => warning.includes('认不出构建名')));
    assert.ok(result.warnings.some((warning) => warning.includes('没有右括号')));
  });

  it('is total and deterministic on hostile inputs', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const result = assertTotal(listing, input, `hostile ${k}`) as { builds: unknown[]; warnings: string[] };
      assert.ok(Array.isArray(result.builds) && Array.isArray(result.warnings));
    }
    const random = seeded(3);
    for (let i = 0; i < 200; i++) {
      const page = Array.from({ length: random.int(8) }, () =>
        random.pick([
          `Rel_FAMX_10_${random.int(9)}_${random.int(9)}_${random.int(99)} (build on 2026-0${1 + random.int(9)}-1${random.int(9)} 1${random.int(9)}:00:00 ):`,
          ' Released on 2026-02-3x',
          '<font color=red>',
          '</font>',
          '<br>',
          '<blockquote><a href=command_tree-x.xml>t</a></blockquote>',
          'based on Rel_FAMX_1_2_3_4',
          '\u0000',
          '（',
        ]),
      ).join('');
      const result = assertTotal(listing, html(page), page) as { builds: Build[] };
      assert.deepEqual(internalWarnings(result), []);
      for (const build of result.builds) assert.ok(build.released === null || /^\d{4}-\d{2}(?:-\d{2})?$/.test(build.released));
    }
  });

  it('reads a page of thousands of entries quickly', () => {
    const parts = ['<html><body><strong>Build Packages</strong><br>'];
    for (let n = 6000; n > 0; n--) {
      const name = `Rel_FAMX_10_6_1_${n}`;
      const red = n % 25 === 0;
      parts.push(`${red ? '<font color=red>' : ''}${name} (build on  2026-01-01 10:00:00 ): ${red ? 'Released on 2026-01-02 </font>' : ''} </br> <BLOCKQUOTE> <A href=/b/DemoOS-${name}.array>x ( 900M , SHA256: ${'a'.repeat(64)} )</A><BR><A href=/b/command_tree-${name}.xml>t</A><BR></BLOCKQUOTE>\n`);
    }
    parts.push('</body></html>');
    const model = html(parts.join(''));
    const start = performance.now();
    const result = parseListing(model);
    const ms = performance.now() - start;
    assert.equal(result.builds.length, 6000);
    assert.equal(result.builds.filter((build) => build.released !== null).length, 240);
    assert.ok(ms < 2000, `took ${ms} ms`);
  });
});

it('reads time before a slash date and records an unrecognized timestamp as a failed build',()=>{
 const source=html('<p>Rel_FAMX_10_6_1_7 (build on 09:30:11 2026/07/02):</p><p>Rel_FAMX_10_6_1_8 (build on not-a-time):</p>');
 const parsed=parseListing(source);
 assert.equal(parsed.builds[0].built,'2026-07-02T09:30:11');
 assert.match(parsed.builds[1].failure??'',/构建时间.*修正/);
});

it('passes a failed timestamp through the plan with its source, original material and a fixed code',async()=>{
 const {planBuilds}=await import('./sync.ts');
 const {INDEX_ID,listingId}=await import('./sources.ts');
 const page=(model:ReturnType<typeof html>)=>({ok:true,media_type:'text/html',parser:'html@1',model,reason:null});
 const out=planBuilds({round:2,options:{lines:['10.6.1']},known:[],read:{
  [INDEX_ID]:page(html('<a href="rel_famx_10_6_1.html">mainline</a>')),
  [listingId('rel_famx_10_6_1')]:page(html('<p>Rel_FAMX_10_6_1_8 (build on not-a-time):</p>')),
 }});
 assert.equal(out.builds.length,0);
 assert.equal(out.failed_builds?.length,1);
 assert.equal(out.failed_builds[0].reason,'SOURCE_UNPARSEABLE');
 assert.equal(out.failed_builds[0].source,listingId('rel_famx_10_6_1'));
 assert.match(String(out.failed_builds[0].raw.built_raw),/not-a-time/);
});
