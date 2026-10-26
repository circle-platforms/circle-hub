import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasCommandTree } from './builds.ts';
import { parseListing } from './listing.ts';
import planSyncFunction, { pageNameOf, planSync, syncBuilds, syncBuildsFunction } from './sync-plan.ts';
import type { Build } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, html, internalWarnings, seeded } from '../testing/test-support.ts';

const index = html(fixtureBytes('index.html'));
const hub = html(fixtureBytes('hub-famx_10_6_2.html'));
const builds = [...parseListing(html(fixtureBytes('listing-famx.html'))).builds, ...parseListing(html(fixtureBytes('listing-famy.html'))).builds];
const newLine = [...parseListing(html(fixtureBytes('listing-famx-new-line.html'))).builds, ...parseListing(html(fixtureBytes('listing-famy-new-line.html'))).builds];
const TREE = { name: 't.xml', href: 't.xml' };

describe('planSync', () => {
  it('selects both families and explicitly configured additional mainline words', () => {
    const plan = planSync({ index,options:{mainline_page_words:['demoqualifier']} });
    assert.deepEqual(
      plan.pages.map((page) => [page.page, page.family, page.line, page.kind, page.from]),
      [
        ['rel_famx_9_2', 'FAMX', '9.2', 'mainline', null],
        ['rel_famx_10_6', 'FAMX', '10.6', 'mainline', null],
        ['rel_famx_10_6_demoqualifier', 'FAMX', '10.6', 'mainline', null],
        ['rel_famx_10_6_1', 'FAMX', '10.6.1', 'mainline', null],
        ['rel_famy_10_6', 'FAMY', '10.6', 'mainline', null],
        ['rel_famy_10_6_1', 'FAMY', '10.6.1', 'mainline', null],
      ],
    );
    assert.equal(plan.pages[0].href, 'rel_famx_9_2.html');
    assert.equal(plan.pages[1].href, 'http://192.0.2.10/builds/rel_famx_10_6.html');
    assert.ok(plan.warnings.some((warning) => warning.includes('1 个重复的页面链接')));
  });

  it('returns the hub pages to read separately, never as listing pages', () => {
    const plan = planSync({ index });
    assert.deepEqual(plan.hubs, [
      { page: 'famx_10_6_2', href: 'http://192.0.2.10/builds/famx_10_6_2.html', family: 'FAMX', line: '10.6.2' },
      { page: 'famx_10_x_patch', href: 'http://192.0.2.10/builds/famx_10_x_patch.html', family: 'FAMX', line: null },
      { page: 'famx_trunk', href: 'http://192.0.2.10/builds/famx_trunk.html', family: 'FAMX', line: null },
    ]);
    const names = new Set(plan.pages.map((page) => page.page));
    for (const item of plan.hubs) assert.ok(!names.has(item.page), item.page);
    const excluded = planSync({ index, options: { exclude: ['famx_10_x_*'] } });
    assert.deepEqual(excluded.hubs.map((item) => item.page), ['famx_10_6_2', 'famx_trunk']);
    assert.equal(excluded.skipped.find((skip) => skip.page === 'famx_10_x_patch')?.reason, '被排除模式排除');
  });

  it('walks index -> hub pages -> listing pages, tolerant of a dead hub link', () => {
    const trunk = html('<font color=red>Rel_FAMX_10_9_0_1 (build on  2026-07-01 10:00:00 ): Released on 2026-07-02 </font><br><blockquote><a href=/builds/command_tree-Rel_FAMX_10_9_0_1.xml>t</a></blockquote>');
    const plan = planSync({
      index,
      hubs: [
        { page: 'famx_trunk', model: trunk },
        { page: 'famx_10_6_2', model: hub },
        { page: 'famx_10_x_patch', model: null },
      ],
    });
    assert.deepEqual(plan.hubs, []);
    const fromHubs = plan.pages.filter((page) => page.from !== null);
    assert.deepEqual(
      fromHubs.map((page) => [page.page, page.href, page.from, page.family, page.line, page.kind]),
      [
        ['rel_famx_10_6_2', '/builds/rel_famx_10_6_2.html', 'famx_10_6_2', 'FAMX', '10.6.2', 'mainline'],
        ['rel_famy_10_6_2', '/builds/rel_famy_10_6_2.html', 'famx_10_6_2', 'FAMY', '10.6.2', 'mainline'],
      ],
    );
    // A hub page that lists builds itself is read as a listing page.
    assert.deepEqual(plan.pages.find((page) => page.page === 'famx_trunk'), { page: 'famx_trunk', href: 'http://192.0.2.10/builds/famx_trunk.html', from: null, family: 'FAMX', line: null, platform: null, kind: 'mainline' });
    assert.ok(plan.warnings.some((warning) => warning.includes('famx_trunk') && warning.includes('构建条目')));
    const reasons = Object.fromEntries(plan.skipped.map((skip) => [skip.page, skip.reason]));
    assert.match(reasons.famx_10_x_patch, /读不出/);
    assert.match(reasons.famx_10_6_3, /超过两层/);
    assert.match(reasons.rel_famx_10_6_2_sy_k, /平台分支页默认不选/);
    assert.match(reasons.rel_famx_10_6_2_BrandOS, /名称不符合列表页命名/);
    assert.match(reasons.rel_other_10_6_2, /不属于本产品的名称族/);
    assert.match(reasons.demostack_10_6_2_special, /名称不符合列表页命名/);
    assert.ok(plan.warnings.some((warning) => warning.includes('2 个重复的页面链接')), plan.warnings.join('\n'));
    // The same answer whatever the order of the hub pages given.
    const again = planSync({ index, hubs: [{ page: 'famx_10_x_patch', model: null }, { page: 'famx_10_6_2', model: hub }, { page: 'famx_trunk', model: trunk }] });
    assert.deepEqual(again, plan);
  });

  it('skips the other pages with a reason each, and never sees links inside comments', () => {
    const plan = planSync({ index });
    const reasons = Object.fromEntries(plan.skipped.map((skip) => [skip.page, skip.reason]));
    assert.match(reasons.rel_famx_10_6_1_sy_demoos12, /平台分支页默认不选/);
    assert.match(reasons.rel_famx_10_6_1_examplebank_poc, /名称不符合列表页命名/);
    assert.match(reasons.rel_famx_10_6_new_feature_2026, /名称不符合列表页命名/);
    assert.match(reasons.rel_famx_10_6_0_100_1_1_examplebank_patch, /补丁页默认不选/);
    assert.match(reasons.rel_other_3_9, /不属于本产品的名称族/);
    assert.match(reasons.afamx10_6_docker, /名称不符合列表页命名/);
    assert.match(reasons['mailto:builds@example.invalid'], /不是页面链接/);
    assert.match(reasons['http://192.0.2.10/images/famx-10.6.ova'], /不是页面链接/);
    assert.ok(!plan.pages.concat(plan.skipped as never[]).some((entry) => (entry as { page: string }).page === 'rel_famx_10_7_9'));
  });

  it('opts declared platform pages in by pattern and out by exclusion, and never admits an undeclared name', () => {
    // `demoqualifier` is a declared mainline word here, so that page is a listing page and the exclusion applies to it;
    // an exclusion never reaches a name the grammar does not declare (classification comes first).
    const plan = planSync({ index, options: { mainline_page_words: ['demoqualifier'], include: ['*_sy_k', 'REL_FAMY_*_SZ_*', 'rel_famx_10_6_1_?xamplebank_*'], exclude: ['*demoqualifier', 'rel_famx_9_*'] } });
    const pages = plan.pages.map((page) => page.page);
    assert.ok(pages.includes('rel_famy_10_6_1_sz_demoos10'), 'a declared platform page is opted in by its pattern');
    // A glob is an opt-in among declared page forms, not a way to read a name the grammar does not declare: these tails
    // are neither a declared mainline word, a whole `patch` token nor `customer_<identifier>`.
    for (const page of ['rel_famx_10_6_1_examplebank_poc', 'rel_famx_sy_k_10_6_1_2_ipv6_sy_k']) {
      assert.ok(!pages.includes(page), page);
      assert.equal(plan.skipped.find((skip) => skip.page === page)?.reason, '名称不符合列表页命名', page);
    }
    assert.ok(!pages.includes('rel_famx_10_6_demoqualifier') && !pages.includes('rel_famx_9_2'));
    const sz = plan.pages.find((page) => page.page === 'rel_famy_10_6_1_sz_demoos10');
    assert.deepEqual(sz, { page: 'rel_famy_10_6_1_sz_demoos10', href: 'http://192.0.2.10/builds/rel_famy_10_6_1_sz_demoos10.html', from: null, family: 'FAMY', line: '10.6.1', platform: 'sz-demoos10', kind: 'platform' });
    assert.equal(plan.skipped.find((skip) => skip.page === 'rel_famx_10_6_demoqualifier')?.reason, '被排除模式排除');
  });

  it('reads several index pages and ignores bad patterns', () => {
    const sub = html('<a href="rel_famx_10_6_3.html">10.6.3</a><a href="rel_famx_10_6.html">again</a>');
    const plan = planSync({ index: [index, sub, null as never], options: { include: ['', 'x'.repeat(300)] } });
    assert.ok(plan.pages.some((page) => page.page === 'rel_famx_10_6_3'));
    assert.ok(plan.warnings.some((warning) => warning.includes('第 3 个索引页')));
    assert.ok(plan.warnings.some((warning) => warning.includes('include 模式为空或超过')));
  });

  it('takes page names from links of every shape', () => {
    assert.equal(pageNameOf('http://192.0.2.10/builds/rel_famx_10_6.html?x=1#top'), 'rel_famx_10_6');
    assert.equal(pageNameOf('famx_10_6_0_special.html.html'), 'famx_10_6_0_special');
    assert.equal(pageNameOf('rel%5Ffamx_10_6.HTM'), 'rel_famx_10_6');
    assert.equal(pageNameOf('rel%E0%A4.html'), 'rel%E0%A4');
    assert.equal(pageNameOf('http://192.0.2.10/builds/'), null);
    assert.equal(pageNameOf('.html'), null);
  });

  it('is total and deterministic on hostile inputs', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(planSyncFunction, input, `hostile ${k}`);
    const random = seeded(13);
    const names = ['rel_famx_10_6', 'rel_famy_1_2_3_sy_k', 'famx_x', 'famx_10_7', 'famy_10_7_1', 'rel_famx_10_6_patch', 'rel_%zz.html', '', 'rel_famx_10_6_1_examplebank'];
    const linksOf = (): string => Array.from({ length: random.int(10) }, () => `<a href="${random.pick(names)}${random.pick(['.html', '.htm', '', '.html.html'])}">x</a>`).join('');
    for (let i = 0; i < 200; i++) {
      const links = linksOf();
      const hubs = random.chance(0.5)
        ? Array.from({ length: random.int(4) }, () => ({ page: random.pick(['famx_10_7', 'famy_10_7_1', 'famx_x', 'rel_famx_10_6', '']), model: random.chance(0.7) ? html(linksOf()) : null }))
        : undefined;
      const input = { index: html(links), hubs, options: { include: [random.pick(['*', '*_k', '?'])], exclude: random.chance(0.2) ? ['famx_x'] : [] } };
      const plan = assertTotal(planSyncFunction, input, links) as ReturnType<typeof planSync>;
      assert.deepEqual(internalWarnings(plan), []);
      const seen = new Set<string>();
      for (const page of plan.pages) {
        assert.ok(!seen.has(page.page.toLowerCase()), 'a page twice');
        seen.add(page.page.toLowerCase());
      }
      for (const item of plan.hubs) {
        assert.ok(!seen.has(item.page.toLowerCase()), 'a hub page listed as a listing page');
        assert.ok(!(hubs ?? []).some((given) => given.page.toLowerCase() === item.page.toLowerCase()), 'a hub page read is not asked for again');
      }
      if (hubs !== undefined) assert.equal(JSON.stringify(planSyncFunction({ ...input, hubs: random.shuffle(hubs) })), JSON.stringify(plan), 'order of the hub pages');
    }
  });
});

describe('syncBuilds', () => {
  it('lists the base builds still to produce and every alias', () => {
    const result = syncBuilds({ builds, existingRoots: ['Rel_FAMX_10_6_1_40'] });
    assert.deepEqual(
      result.produce.map((build) => build.name),
      ['Rel_FAMX_10_6_1_37', 'Rel_FAMX_10_6_1_50', 'Rel_FAMX_10_6_1_54', 'Rel_FAMX_10_6_1_57'],
    );
    assert.deepEqual(result.aliases, [
      { alias: 'Rel_FAMY_10_6_1_33', base: 'Rel_FAMX_10_6_1_54', released: '2026-05-06', platform: null },
      { alias: 'Rel_FAMY_10_6_1_40', base: 'Rel_FAMX_10_6_1_56', released: null, platform: null },
      { alias: 'Rel_FAMY_10_6_1_41', base: 'Rel_FAMX_10_6_1_57', released: '2026-05-22', platform: null },
    ]);
    assert.deepEqual(
      result.skipped.map((skip) => skip.name),
      ['BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click', 'Rel_FAMX_10_6_1_40', 'Rel_FAMY_10_6_1_12', 'Rel_FAMY_10_6_1_30'],
    );
    assert.equal(result.skipped[1].reason, '知识库里已有该构建的根');
    assert.equal(result.unreleased, 6);
  });

  it('produces FAMY builds that have their own command tree, as their own base (newest lines)', () => {
    const result = syncBuilds({ builds: newLine, existingRoots: [] });
    assert.deepEqual(result.produce.map((build) => build.name), ['Rel_FAMX_10_7_1_6', 'Rel_FAMY_10_7_1_6', 'Rel_FAMX_10_7_1_8', 'Rel_FAMY_10_7_1_8']);
    assert.deepEqual(result.aliases, []);
    assert.deepEqual(result.skipped.map((skip) => [skip.name, skip.reason.includes('没有命令树，也没有写明基础构建')]), [['Rel_FAMY_10_7_1_3', true]]);
    assert.equal(result.unreleased, 1);
    const famyOnly = syncBuilds({ builds: parseListing(html(fixtureBytes('listing-famy-new-line.html'))).builds, existingRoots: [] });
    assert.deepEqual(famyOnly.produce.map((build) => build.name), ['Rel_FAMY_10_7_1_6', 'Rel_FAMY_10_7_1_8']);
  });

  it('records the alias of an unreleased FAMY build whose base resolves, without producing for it', () => {
    const base: Build = { name: 'Rel_FAMX_9_8_2_196', family: 'FAMX', platform: null, line: '9.8.2', number: '196', built: null, released: '2026-02-01', basedOn: null, files: { image: null, commandTree: TREE } };
    const alias: Build = { ...base, name: 'Rel_FAMY_9_8_2_37', family: 'FAMY', number: '37', released: null, basedOn: base.name, files: { image: null } };
    const result = syncBuilds({ builds: [alias, base], existingRoots: [base.name] });
    assert.deepEqual(result.aliases, [{ alias: 'Rel_FAMY_9_8_2_37', base: 'Rel_FAMX_9_8_2_196', released: null, platform: null }]);
    assert.deepEqual(result.produce, []);
    const unreleasedBase = syncBuilds({ builds: [alias, { ...base, released: null }], existingRoots: [] });
    assert.deepEqual([unreleasedBase.produce, unreleasedBase.aliases.length, unreleasedBase.unreleased], [[], 1, 2]);
  });

  it('counts a command tree only when the build links one', () => {
    const shapes: unknown[] = [null, 'x', {}, { name: '', href: '' }, { name: 't.xml', href: '   ' }, { name: 't.xml' }];
    const bad = shapes.map((tree, k) => ({ name: `Rel_FAMX_9_8_3_${k}`, family: 'FAMX', platform: null, line: '9.8.3', number: String(k), built: null, released: '2026-01-01', basedOn: null, files: { image: null, commandTree: tree } }));
    const good: Build = { name: 'Rel_FAMX_9_8_3_9', family: 'FAMX', platform: null, line: '9.8.3', number: '9', built: null, released: '2026-01-01', basedOn: null, files: { image: null, commandTree: TREE } };
    const result = syncBuilds({ builds: [...(bad as Build[]), good], existingRoots: [] });
    assert.deepEqual(result.produce.map((build) => build.name), ['Rel_FAMX_9_8_3_9']);
    assert.deepEqual(result.skipped, bad.map((item) => ({ name: item.name, reason: '没有命令树' })));
  });

  it('does not depend on the order of the builds, duplicates with different content included', () => {
    const copy = (name: string, fields: Partial<Build>): Build => ({ name, family: 'FAMX', platform: null, line: '9.8.1', number: '5', built: '2026-03-01T10:00:00', released: null, basedOn: null, files: { image: null }, ...fields });
    const pool = [
      copy('Rel_FAMX_9_8_1_5', { released: '2026-03-02', files: { image: null, commandTree: TREE } }),
      copy('Rel_FAMX_9_8_1_5', {}),
      copy('Rel_FAMX_9_8_1_4', { number: '4', released: '2026-02-21', files: { image: null, commandTree: TREE } }),
      copy('Rel_FAMX_9_8_1_3', { number: '3', released: '2026-01-21' }),
      copy('Rel_FAMX_9_8_1_3', { number: '3', released: '2026-01-21', platform: 'sy-demoos12' }),
      copy('Rel_FAMY_9_8_1_2', { family: 'FAMY', number: '2', released: '2026-01-02', basedOn: 'Rel_FAMX_9_8_1_9' }),
      ...builds,
    ];
    const expected = syncBuilds({ builds: pool, existingRoots: [] });
    assert.deepEqual(expected.produce.filter((build) => build.line === '9.8.1').map((build) => build.name), ['Rel_FAMX_9_8_1_4', 'Rel_FAMX_9_8_1_5']);
    const names = expected.skipped.map((skip) => skip.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(expected.warnings.some((warning) => warning.includes('Rel_FAMX_9_8_1_5 出现了 2 次')), expected.warnings.join('\n'));
    const random = seeded(43);
    for (let i = 0; i < 60; i++) assert.equal(JSON.stringify(syncBuilds({ builds: random.shuffle(pool), existingRoots: [] })), JSON.stringify(expected));
  });

  it('produces an unreleased base for a released alias, and nothing without a command tree', () => {
    const base: Build = { name: 'Rel_FAMX_9_2_1_8', family: 'FAMX', platform: null, line: '9.2.1', number: '8', built: null, released: null, basedOn: null, files: { image: null, commandTree: { name: 't.xml', href: 't.xml' } } };
    const alias: Build = { ...base, name: 'Rel_FAMY_9_2_1_3', family: 'FAMY', number: '3', released: '2026-02-02', basedOn: base.name, files: { image: null } };
    const bare: Build = { ...base, name: 'Rel_FAMX_9_2_1_9', number: '9', released: '2026-03-03', files: { image: null } };
    const result = syncBuilds({ builds: [base, alias, bare], existingRoots: [{ build: 'Rel_FAMX_0_0_0_0' }] });
    assert.deepEqual(result.produce.map((build) => build.name), ['Rel_FAMX_9_2_1_8']);
    assert.deepEqual(result.aliases.map((item) => [item.alias, item.base]), [['Rel_FAMY_9_2_1_3', 'Rel_FAMX_9_2_1_8']]);
    assert.deepEqual(result.skipped, [{ name: 'Rel_FAMX_9_2_1_9', reason: '没有命令树' }]);
    assert.equal(result.unreleased, 0);
  });

  it('is idempotent: produced roots are not produced again', () => {
    const first = syncBuilds({ builds, existingRoots: [] });
    const second = syncBuilds({ builds, existingRoots: first.produce.map((build) => build.name) });
    assert.deepEqual(second.produce, []);
    assert.deepEqual(second.aliases, first.aliases);
  });

  it('keeps its invariants on random builds', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(syncBuildsFunction, input, `hostile ${k}`);
    const random = seeded(17);
    for (let i = 0; i < 300; i++) {
      const pool: Build[] = Array.from({ length: random.int(14) }, (_, k) => ({
        name: `${random.pick(['Rel_FAMX', 'Rel_FAMY', 'Rel_OTHER'])}_9_2_1_${k}`,
        family: random.pick(['FAMX', 'FAMY', 'other'] as const),
        platform: null,
        line: '9.2.1',
        number: String(k),
        built: null,
        released: random.chance(0.6) ? '2026-01-01' : null,
        basedOn: random.chance(0.6) ? `Rel_FAMX_9_2_1_${random.int(14)}` : null,
        files: random.chance(0.7) ? { image: null, commandTree: { name: 't', href: 't' } } : { image: null },
      }));
      const existing = pool.filter(() => random.chance(0.2)).map((build) => build.name);
      const result = assertTotal(syncBuildsFunction, { builds: pool, existingRoots: existing }, String(i)) as ReturnType<typeof syncBuilds>;
      assert.deepEqual(internalWarnings(result), []);
      for (const build of result.produce) {
        assert.ok(hasCommandTree(build));
        assert.ok(!existing.includes(build.name));
        assert.notEqual(build.family, 'other');
      }
      // An alias has no tree of its own and names a base that is an FAMX build or a build with its own tree.
      for (const alias of result.aliases) {
        assert.ok(pool.some((build) => build.name === alias.alias && build.family === 'FAMY' && !hasCommandTree(build)), alias.alias);
        assert.ok(pool.some((build) => build.name === alias.base && (build.family === 'FAMX' || (build.family === 'FAMY' && hasCommandTree(build)))), alias.base);
      }
      assert.equal(new Set(result.produce.map((build) => build.name)).size, result.produce.length);
    }
  });
});
