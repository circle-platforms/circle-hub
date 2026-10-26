// The opted-in platform pages of the sync plan (the famx-platform-pages task): the include patterns come from the
// pack-declared variable FAMX_INCLUDE_PAGES, and an opted-in page lists its newest build per version line, name family
// and platform even when it is not released (a Beta build under test: released_at null, so an include-unreleased sync
// can produce its root when the page links its command tree; without a tree link the build is listed by name only, as
// the page states). All names and pages here are synthetic; addresses are in 192.0.2.0/24.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { html, latin1 } from '../testing/test-support.ts';
import { INDEX_ID, listingId } from './sources.ts';
import { planBuilds } from './sync.ts';

type Read = { ok: boolean; media_type: string | null; parser: string | null; model: unknown; reason: string | null };

const HTML_TYPE = 'text/html; charset=ISO-8859-1';

/** The synthetic index: one link to the opted-in platform page (a mainline page would be selected on its own). */
const INDEX = () => html(latin1('<html><body><A HREF=http://192.0.2.10/builds/rel_famx_zx_u_10_8.html>rel_famx_zx_u_10_8 builds</A><BR><BR></body></html>'));

/** One red released entry of a listing page, with the links the page states. */
const released = (name: string, built: string, date: string, links: string[]): string =>
  `<font color=red>${name} (build on  ${built} ): Released on ${date} </font> </br> <BLOCKQUOTE> ${links.map((href) => `<A href=${href}>http://192.0.2.10${href}</A>`).join('<BR>')}<BR></BLOCKQUOTE>`;

/** One unreleased entry (no red font, no release date), with the links the page states. */
const unreleased = (name: string, built: string, links: string[]): string =>
  `${name} (build on  ${built} ) </br> <BLOCKQUOTE> ${links.map((href) => `<A href=${href}>http://192.0.2.10${href}</A>`).join('<BR>')}<BR></BLOCKQUOTE>`;

const page = (body: string): Read => ({ ok: true, media_type: HTML_TYPE, parser: 'html@1', model: html(latin1(`<html><body>${body}</body></html>`)), reason: null });

/** Runs the plan the way the knowledge sync does: answer what it asks for, until it is done. */
function runSync(pages: Record<string, string>, options: Record<string, unknown>): ReturnType<typeof planBuilds> {
  const read: Record<string, Read> = { [INDEX_ID]: { ok: true, media_type: HTML_TYPE, parser: 'html@1', model: INDEX(), reason: null } };
  for (let round = 1; round <= 4; round++) {
    const output = planBuilds({ round, options, read, known: [] });
    assert.ok(SyncPlanOutput.safeParse(output).success, `round ${round}: ${JSON.stringify(SyncPlanOutput.safeParse(output).error?.issues.slice(0, 3))}`);
    if (output.done) return output;
    for (const id of output.fetch) {
      const name = id.slice('buildsite:listing:'.length);
      const body = pages[name];
      read[id] = body === undefined ? { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' } : page(body);
    }
  }
  assert.fail('the plan did not finish in 4 rounds');
}

describe('an opted-in platform page lists its newest build per line, family and platform, released or not', () => {
  const output = runSync({
    rel_famx_zx_u_10_8: [
      released('Beta_FAMX-ZX-U_10_8_0_901', '2026-09-28 10:00:00', '2026-10-01', ['/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_901.xml']).trim(),
      unreleased('Beta_FAMX-ZX-U_10_8_0_902', '2026-10-15 10:00:00', ['/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_902.xml']).trim(),
    ].join('\n'),
  }, { include: ['rel_famx_zx_u_10_8'] });
  const byName = new Map(output.builds.map((b) => [b.name, b]));

  it('lists the released build and the newest unreleased Beta build of the platform line', () => {
    assert.deepEqual(byName.get('Beta_FAMX-ZX-U_10_8_0_901'), {
      name: 'Beta_FAMX-ZX-U_10_8_0_901',
      family: 'FAMX',
      line: '10.8',
      base: 'Beta_FAMX-ZX-U_10_8_0_901',
      platform: 'zx-u',
      built_at: '2026-09-28T10:00:00Z',
      released_at: '2026-10-01T00:00:00Z',
      sources: { tree: 'buildsite:file:/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_901.xml' },
    });
    const newest = byName.get('Beta_FAMX-ZX-U_10_8_0_902');
    assert.deepEqual([newest?.platform, newest?.released_at, newest?.base, newest?.sources], [
      'zx-u', null, 'Beta_FAMX-ZX-U_10_8_0_902', { tree: 'buildsite:file:/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_902.xml' },
    ], '未发布的最新构建照样列出，页面链接了命令树，带树来源');
  });

  it('without the include pattern the platform page is not read and no Beta build is listed', () => {
    const plain = runSync({}, {});
    assert.ok(plain.builds.length === 0, plain.builds.map((b) => b.name).join(','));
  });
});

describe('the newest unreleased build without a command-tree link is listed by name only, as the page states', () => {
  const output = runSync({
    rel_famx_zx_u_10_8: [unreleased('Beta_FAMX-ZX-U_10_8_0_903', '2026-10-20 09:00:00', ['/builds/DemoOS-Beta_FAMX-ZX-U_10_8_0_903.array']).trim()].join('\n'),
  }, { include: ['rel_famx_zx_u_10_8'] });
  const build = output.builds.find((b) => b.name === 'Beta_FAMX-ZX-U_10_8_0_903');

  it('lists the build with no release and no sources', () => {
    assert.deepEqual([build?.platform, build?.released_at, build?.base, build?.sources], ['zx-u', null, 'Beta_FAMX-ZX-U_10_8_0_903', {}]);
  });
});
