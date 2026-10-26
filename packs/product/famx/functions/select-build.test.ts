import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasCommandTree } from './builds.ts';
import { parseListing } from './listing.ts';
import selectBuildFunction, { compareForRule, indexBuilds, resolveBase, selectBuild } from './select-build.ts';
import type { Build } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, html, internalWarnings, seeded } from '../testing/test-support.ts';

const candidates = [...parseListing(html(fixtureBytes('listing-famx.html'))).builds, ...parseListing(html(fixtureBytes('listing-famy.html'))).builds];
// The newest-line regime: FAMY entries with their own command tree and no "based on".
const newLine = [...parseListing(html(fixtureBytes('listing-famx-new-line.html'))).builds, ...parseListing(html(fixtureBytes('listing-famy-new-line.html'))).builds];
const TREE = { name: 'command_tree.xml', href: '/builds/command_tree.xml' };

function build(name: string, fields: Partial<Build> = {}): Build {
  return { name, family: 'FAMX', platform: null, line: '9.2.1', number: '1', built: null, released: null, basedOn: null, files: { image: null }, ...fields };
}

describe('FAMY builds with their own command tree (newest lines)', () => {
  it('reads the pages of both regimes', () => {
    assert.deepEqual(
      newLine.map((item) => [item.name, item.basedOn, item.released, hasCommandTree(item)]),
      [
        ['Rel_FAMX_10_7_1_8', null, '2026-06-03', true],
        ['Rel_FAMX_10_7_1_6', null, '2026-05-02', true],
        ['Rel_FAMY_10_7_1_9', null, null, true],
        ['Rel_FAMY_10_7_1_8', null, '2026-06-05', true],
        ['Rel_FAMY_10_7_1_6', null, '2026-05-04', true],
        ['Rel_FAMY_10_7_1_3', null, '2026-03-03', false],
      ],
    );
  });

  it('locks the FAMY build itself when the rule picks it', () => {
    const result = selectBuild({ candidates: newLine, line: '10.7.1' });
    assert.deepEqual([result.build?.name, result.base?.name, result.basis], ['Rel_FAMY_10_7_1_8', 'Rel_FAMY_10_7_1_8', 'projected']);
    assert.deepEqual(
      result.alternatives.map((alternative) => alternative.name),
      ['Rel_FAMX_10_7_1_8', 'Rel_FAMY_10_7_1_6', 'Rel_FAMX_10_7_1_6', 'Rel_FAMY_10_7_1_3'],
    );
    assert.ok(!result.notes.some((note) => note.includes('无法确定')), result.notes.join('\n'));
  });

  it('locks the FAMY build itself when it is declared, and says why a build without a tree has no root', () => {
    const declared = selectBuild({ candidates: newLine, line: '10.7.1', declared: 'Rel_FAMY_10_7_1_8' });
    assert.deepEqual([declared.build?.name, declared.base?.name, declared.basis], ['Rel_FAMY_10_7_1_8', 'Rel_FAMY_10_7_1_8', 'declared']);
    const bare = selectBuild({ candidates: newLine, line: '10.7.1', declared: 'Rel_FAMY_10_7_1_3' });
    assert.equal(bare.base, null);
    assert.ok(bare.notes.some((note) => note.includes('Rel_FAMY_10_7_1_3 没有命令树，也没有写明基础构建')));
  });

  it('prefers the own tree over a "based on" text, and follows a chain to an FAMY build that has a tree', () => {
    const own = build('Rel_FAMY_9_8_6_8', { family: 'FAMY', released: '2026-01-09', basedOn: 'Rel_FAMX_9_8_6_8', files: { image: null, commandTree: TREE } });
    const twin = build('Rel_FAMX_9_8_6_8', { released: '2026-01-07', files: { image: null, commandTree: TREE } });
    const result = selectBuild({ candidates: [own, twin], line: '9.8.6', declared: 'Rel_FAMY_9_8_6_8' });
    assert.equal(result.base?.name, 'Rel_FAMY_9_8_6_8');
    assert.ok(result.notes.some((note) => note.includes('自带命令树')));
    const alias = build('Rel_FAMY_9_8_6_9', { family: 'FAMY', released: '2026-01-10', basedOn: 'Rel_FAMY_9_8_6_8' });
    assert.equal(selectBuild({ candidates: [alias, own, twin], line: '9.8.6', declared: 'Rel_FAMY_9_8_6_9' }).base?.name, 'Rel_FAMY_9_8_6_8');
  });

  it('passes over a newer build whose root cannot be determined, with a note, and keeps it among the alternatives', () => {
    const lost = build('Rel_FAMY_9_8_6_9', { family: 'FAMY', line: '9.8.6', released: '2026-02-01', basedOn: 'Rel_FAMX_9_8_6_99' });
    const twin = build('Rel_FAMX_9_8_6_8', { line: '9.8.6', released: '2026-01-07', files: { image: null, commandTree: TREE } });
    const result = selectBuild({ candidates: [lost, twin], line: '9.8.6' });
    assert.deepEqual([result.build?.name, result.base?.name], ['Rel_FAMX_9_8_6_8', 'Rel_FAMX_9_8_6_8']);
    assert.deepEqual(result.alternatives.map((alternative) => alternative.name), ['Rel_FAMY_9_8_6_9']);
    assert.ok(result.notes.some((note) => note.includes('Rel_FAMY_9_8_6_9') && note.includes('改选 Rel_FAMX_9_8_6_8')), result.notes.join('\n'));
    // When no qualifying build has a root, the best one is still named, without a base.
    const alone = selectBuild({ candidates: [lost], line: '9.8.6' });
    assert.deepEqual([alone.build?.name, alone.base], ['Rel_FAMY_9_8_6_9', null]);
  });
});

describe('a build name listed more than once', () => {
  const released = build('Rel_FAMX_9_8_1_5', { line: '9.8.1', built: '2026-03-01T10:00:00', released: '2026-03-02', files: { image: null, commandTree: TREE } });
  const unreleased = build('Rel_FAMX_9_8_1_5', { line: '9.8.1', built: '2026-03-01T10:00:00', released: null });
  const older = build('Rel_FAMX_9_8_1_4', { line: '9.8.1', built: '2026-02-20T10:00:00', released: '2026-02-21', files: { image: null, commandTree: TREE } });
  const plain = build('Rel_FAMX_9_8_1_3', { line: '9.8.1', built: '2026-01-20T10:00:00', released: '2026-01-21' });
  const onPlatformPage = { ...plain, platform: 'sy-demoos12' };
  const pool = [released, unreleased, older, plain, onPlatformPage];

  it('keeps one copy by content, whatever the order of the candidates', () => {
    const expected = selectBuild({ candidates: pool, line: '9.8.1' });
    assert.equal(expected.build?.name, 'Rel_FAMX_9_8_1_5');
    assert.ok(expected.notes.some((note) => note.includes('Rel_FAMX_9_8_1_5 出现了 2 次')), expected.notes.join('\n'));
    assert.ok(expected.notes.some((note) => note.includes('Rel_FAMX_9_8_1_3 出现了 2 次')), expected.notes.join('\n'));
    const random = seeded(41);
    for (let i = 0; i < 60; i++) assert.equal(JSON.stringify(selectBuild({ candidates: random.shuffle(pool), line: '9.8.1' })), JSON.stringify(expected));
  });

  it('orders copies by build time, then release, then the command tree', () => {
    const later = build('Rel_FAMX_9_8_1_5', { line: '9.8.1', built: '2026-03-01T11:00:00', released: null });
    assert.equal(indexBuilds([released, later], []).get('Rel_FAMX_9_8_1_5')?.built, '2026-03-01T11:00:00');
    const releasedLater = { ...released, released: '2026-03-05', files: { image: null } };
    assert.equal(indexBuilds([released, releasedLater], []).get('Rel_FAMX_9_8_1_5')?.released, '2026-03-05');
    const withoutTree = { ...released, files: { image: null } };
    assert.ok(hasCommandTree(indexBuilds([withoutTree, released], []).get('Rel_FAMX_9_8_1_5') as Build));
    const notes: string[] = [];
    indexBuilds([released, { ...released }], notes);
    assert.deepEqual(notes, [], 'identical copies need no note');
  });
});

describe('the rule: latest released build of the line across both families, main platform', () => {
  it('picks the FAMY alias released last and resolves it to its base FAMX build', () => {
    const result = selectBuild({ candidates, line: '10.6.1' });
    assert.equal(result.build?.name, 'Rel_FAMY_10_6_1_41');
    assert.equal(result.base?.name, 'Rel_FAMX_10_6_1_57');
    assert.equal(result.basis, 'projected');
    assert.deepEqual(
      result.alternatives.map((alternative) => alternative.name),
      ['Rel_FAMX_10_6_1_57', 'Rel_FAMY_10_6_1_33', 'Rel_FAMX_10_6_1_54', 'Rel_FAMY_10_6_1_30', 'Rel_FAMX_10_6_1_50', 'Rel_FAMX_10_6_1_40', 'Rel_FAMX_10_6_1_37', 'Rel_FAMY_10_6_1_12'],
    );
    assert.ok(result.notes[0].includes('Rel_FAMY_10_6_1_41'));
  });

  it('leaves out other platforms, variants and unreleased builds unless a platform is included', () => {
    const names = selectBuild({ candidates, line: '10.6.1' }).alternatives.map((alternative) => alternative.name);
    for (const left of ['BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click', 'Rel_FAMX_10_6_1_56', 'Rel_FAMX_10_6_1_38', 'Beta_FAMX_10_6_1_120']) assert.ok(!names.includes(left), left);
    const platform = [build('Rel_FAMX-SY-K_9_2_1_8_1', { platform: 'sy-k', released: '2026-02-02' }), build('Rel_FAMX_9_2_1_7', { released: '2026-01-01' })];
    assert.equal(selectBuild({ candidates: platform, line: '9.2.1' }).build?.name, 'Rel_FAMX_9_2_1_7');
    assert.equal(selectBuild({ candidates: platform, line: '9.2.1', includePlatforms: ['SY-K'] }).build?.name, 'Rel_FAMX-SY-K_9_2_1_8_1');
  });

  it('reads a null variant from JSON as no variant and names an included platform in the note', () => {
    const fromJson = [{ ...build('Rel_FAMX_9_2_1_5', { released: '2026-01-01' }), variant: null }] as unknown as Build[];
    assert.equal(selectBuild({ candidates: fromJson, line: '9.2.1' }).build?.name, 'Rel_FAMX_9_2_1_5');
    const platform = selectBuild({ candidates: [build('Rel_FAMX-SY-K_9_2_1_8_1', { platform: 'sy-k', released: '2026-02-02' })], line: '9.2.1', includePlatforms: ['sy-k'] });
    assert.ok(platform.notes[0].includes('sy-k 平台构建'));
  });

  it('treats 9.2 and 9.2.0 as one line', () => {
    const lines = [build('Rel_FAMX_9_2_0_5', { line: '9.2.0', released: '2025-05-05' })];
    assert.equal(selectBuild({ candidates: lines, line: '9.2' }).build?.name, 'Rel_FAMX_9_2_0_5');
    assert.equal(selectBuild({ candidates: lines, line: '9.2.0' }).build?.name, 'Rel_FAMX_9_2_0_5');
    assert.equal(selectBuild({ candidates: lines, line: '9.2.1' }).build, null);
  });

  it('breaks ties by build time, then FAMX before FAMY, then build number, then name', () => {
    const day = '2026-03-03';
    const tied = [
      build('Rel_FAMY_9_2_1_9', { family: 'FAMY', released: day, built: '2026-03-01T10:00:00', basedOn: 'Rel_FAMX_9_2_1_2', number: '9' }),
      build('Rel_FAMX_9_2_1_2', { released: day, built: '2026-03-01T10:00:00', number: '2' }),
      build('Rel_FAMX_9_2_1_3', { released: day, built: '2026-03-01T09:00:00', number: '3' }),
      build('Rel_FAMX_9_2_1_10', { released: day, built: '2026-03-01T09:00:00', number: '10' }),
    ];
    const result = selectBuild({ candidates: tied, line: '9.2.1' });
    assert.deepEqual([result.build?.name, ...result.alternatives.map((alternative) => alternative.name)], ['Rel_FAMX_9_2_1_2', 'Rel_FAMY_9_2_1_9', 'Rel_FAMX_9_2_1_10', 'Rel_FAMX_9_2_1_3']);
    assert.ok(result.notes.some((note) => note.includes('同日发布')));
  });

  it('does not depend on the order of the candidates', () => {
    const random = seeded(5);
    const expected = JSON.stringify(selectBuild({ candidates, line: '10.6.1' }));
    for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(selectBuild({ candidates: random.shuffle(candidates), line: '10.6.1' })), expected);
  });

  it('says why nothing qualifies', () => {
    const none = selectBuild({ candidates, line: '10.6.9' });
    assert.equal(none.build, null);
    assert.ok(none.notes[0].includes('没有版本线 10.6.9 的构建'));
    const unreleased = selectBuild({ candidates: [build('Rel_FAMX_9_2_1_1'), build('Rel_FAMX-SY-K_9_2_1_1_1', { platform: 'sy-k', released: '2026-01-01' })], line: '9.2.1' });
    assert.equal(unreleased.build, null);
    assert.ok(unreleased.notes[0].includes('1 个未发布') && unreleased.notes[0].includes('1 个属于其他平台'));
    assert.ok(selectBuild({ candidates, line: '' }).notes[0].includes('没有给版本线'));
  });

  it('keeps an FAMY choice whose base is unknown and says so', () => {
    const result = selectBuild({ candidates: [build('Rel_FAMY_9_2_1_4', { family: 'FAMY', released: '2026-01-01', basedOn: 'Rel_FAMX_9_2_1_99' })], line: '9.2.1' });
    assert.equal(result.build?.name, 'Rel_FAMY_9_2_1_4');
    assert.equal(result.base, null);
    assert.ok(result.notes.some((note) => note.includes('Rel_FAMX_9_2_1_99 不在候选构建里')));
  });
});

describe('a declared build wins', () => {
  it('takes either family and resolves an FAMY name to its base', () => {
    const result = selectBuild({ candidates, line: '10.6.1', declared: 'Rel_FAMY_10_6_1_33' });
    assert.deepEqual([result.build?.name, result.base?.name, result.basis, result.alternatives.length], ['Rel_FAMY_10_6_1_33', 'Rel_FAMX_10_6_1_54', 'declared', 0]);
    const famx = selectBuild({ candidates, line: '10.6.1', declared: 'Rel_FAMX_10_6_1_56' });
    assert.deepEqual([famx.build?.name, famx.base?.name], ['Rel_FAMX_10_6_1_56', 'Rel_FAMX_10_6_1_56']);
    assert.ok(famx.notes.some((note) => note.includes('没有发布记录')));
  });

  it('matches a name without case when that is unique, notes other lines and platforms', () => {
    const result = selectBuild({ candidates, line: '10.6', declared: ' rel_famx_10_6_1_40 ' });
    assert.equal(result.build?.name, 'Rel_FAMX_10_6_1_40');
    assert.ok(result.notes.some((note) => note.includes('不区分大小写')));
    assert.ok(result.notes.some((note) => note.includes('属于版本线 10.6.1，不是 10.6')));
    const platform = selectBuild({ candidates, line: '10.6.1', declared: 'BrandOS-Rel_FAMY-SY-K_10_6_1_3_2_7.click' });
    assert.equal(platform.base, null);
    assert.ok(platform.notes.some((note) => note.includes('sy-k 平台')) && platform.notes.some((note) => note.includes('变体构建')));
  });

  it('refuses names it does not know or that are not the product', () => {
    const unknown = selectBuild({ candidates, line: '10.6.1', declared: 'Rel_FAMX_10_6_1_99' });
    assert.deepEqual([unknown.build, unknown.base, unknown.basis], [null, null, 'declared']);
    assert.ok(unknown.notes[0].includes('不在候选构建里'));
    const other = selectBuild({ candidates: [build('Rel_OTHER_3_9_1_1', { family: 'other' })], line: '3.9.1', declared: 'Rel_OTHER_3_9_1_1' });
    assert.equal(other.build, null);
    assert.ok(other.notes[0].includes('不属于 FAMX 或 FAMY'));
  });

  it('follows a chain of FAMY names and stops at a cycle', () => {
    const chain = [
      build('Rel_FAMY_9_2_1_3', { family: 'FAMY', basedOn: 'Rel_FAMY_9_2_1_2' }),
      build('Rel_FAMY_9_2_1_2', { family: 'FAMY', basedOn: 'Rel_FAMX_9_2_1_1' }),
      build('Rel_FAMX_9_2_1_1'),
    ];
    const result = selectBuild({ candidates: chain, line: '9.2.1', declared: 'Rel_FAMY_9_2_1_3' });
    assert.equal(result.base?.name, 'Rel_FAMX_9_2_1_1');
    assert.ok(result.notes.some((note) => note.includes('→')));
    const cycle = [build('Rel_FAMY_9_2_1_3', { family: 'FAMY', basedOn: 'Rel_FAMY_9_2_1_2' }), build('Rel_FAMY_9_2_1_2', { family: 'FAMY', basedOn: 'Rel_FAMY_9_2_1_3' })];
    const looped = selectBuild({ candidates: cycle, line: '9.2.1', declared: 'Rel_FAMY_9_2_1_3' });
    assert.equal(looped.base, null);
    assert.ok(looped.notes.some((note) => note.includes('有环')));
    // A base must carry one of the product's names.
    const foreign = [build('Rel_FAMY_9_2_1_4', { family: 'FAMY', basedOn: 'Rel_OTHER_9_2_1_4' }), build('Rel_OTHER_9_2_1_4', { family: 'other', files: { image: null, commandTree: TREE } })];
    const elsewhere = selectBuild({ candidates: foreign, line: '9.2.1', declared: 'Rel_FAMY_9_2_1_4' });
    assert.equal(elsewhere.base, null);
    assert.ok(elsewhere.notes.some((note) => note.includes('不属于 FAMX 或 FAMY 名称族')));
  });
});

describe('selection on bad input', () => {
  it('ignores malformed candidates and keeps the later duplicate', () => {
    const result = selectBuild({
      candidates: [null, { name: 5 }, build('Rel_FAMX_9_2_1_1', { released: '2026-01-01', built: '2026-01-01T00:00:00' }), build('Rel_FAMX_9_2_1_1', { released: '2026-02-02', built: '2026-02-01T00:00:00' })] as Build[],
      line: '9.2.1',
    });
    assert.equal(result.build?.released, '2026-02-02');
    assert.ok(result.notes.some((note) => note.includes('2 个候选构建格式不对')));
  });

  it('is total and deterministic on hostile inputs', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const result = assertTotal(selectBuildFunction, input, `hostile ${k}`) as { notes: string[]; build: unknown };
      assert.ok(Array.isArray(result.notes));
    }
    const random = seeded(9);
    for (let i = 0; i < 300; i++) {
      const pool = Array.from({ length: random.int(12) }, (_, k) =>
        build(`Rel_${random.pick(['FAMX', 'FAMY'])}_9_2_${random.int(3)}_${random.int(8)}`, {
          family: random.pick(['FAMX', 'FAMY', 'other'] as const),
          line: `9.2.${random.int(3)}`,
          released: random.chance(0.5) ? `2026-0${1 + random.int(9)}-1${random.int(9)}` : null,
          built: random.chance(0.5) ? `2026-01-0${1 + random.int(9)}T00:00:00` : null,
          platform: random.chance(0.2) ? 'sy-k' : null,
          basedOn: random.chance(0.5) ? `Rel_${random.pick(['FAMX', 'FAMY'])}_9_2_${random.int(3)}_${random.int(8)}` : null,
          files: random.chance(0.5) ? { image: null, commandTree: TREE } : { image: null },
        }),
      );
      const input = { candidates: pool, line: `9.2.${random.int(3)}`, declared: random.chance(0.3) ? pool[0]?.name : undefined };
      const result = assertTotal(selectBuildFunction, input, JSON.stringify(input)) as ReturnType<typeof selectBuild>;
      assert.deepEqual(internalWarnings(result), []);
      if (result.build !== null) assert.ok(pool.some((candidate) => candidate.name === result.build?.name));
      // A base is an FAMX-named build or a build with its own command tree, never an FAMY alias or another product's build.
      if (result.base !== null) assert.ok(result.base.family === 'FAMX' || (result.base.family === 'FAMY' && hasCommandTree(result.base)), JSON.stringify(result.base));
      if (result.basis === 'projected' && result.build !== null) {
        assert.notEqual(result.build.released, null);
        // Alternatives ranked before the chosen build were passed over because their root cannot be determined.
        const byName = indexBuilds(pool, []);
        const chosen = result.build;
        for (const better of result.alternatives.filter((alternative) => compareForRule(alternative, chosen) < 0)) {
          assert.equal(resolveBase(better, byName, []), null, better.name);
          assert.notEqual(result.base, null);
        }
      }
      assert.equal(JSON.stringify(selectBuildFunction({ ...input, candidates: random.shuffle(pool) })), JSON.stringify(result), 'order of the candidates');
    }
  });
});
