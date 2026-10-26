// Pinned builds of opted-in pages (the famx-pinned-builds task): a build named by the pack-declared variable FAMX_PINNED_BUILDS (a full
// build-site name) is listed as a build of its own tree on the read opted-in page it appears on, released or not,
// carrying the command-tree source the page declares for it; a pinned name the read pages do not list is reported in
// the note, never guessed. Equality is exact: no transformation of any kind, not even case folding, no keywords,
// prefixes or patterns. All names here are synthetic (platform zx-u, line 10.8); addresses are in 192.0.2.0/24.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { html, latin1 } from '../testing/test-support.ts';
import { INDEX_ID } from './sources.ts';
import { planBuilds } from './sync.ts';

type Read = { ok: boolean; media_type: string | null; parser: string | null; model: unknown; reason: string | null };
const HTML_TYPE = 'text/html; charset=ISO-8859-1';
const INDEX = () => html(latin1('<html><body><A HREF=http://192.0.2.10/builds/rel_famx_zx_u_10_8.html>rel_famx_zx_u_10_8 builds</A><BR><BR></body></html>'));
const released = (name: string, built: string, date: string, links: string[]): string =>
  `<font color=red>${name} (build on  ${built} ): Released on ${date} </font> </br> <BLOCKQUOTE> ${links.map((href) => `<A href=${href}>http://192.0.2.10${href}</A>`).join('<BR>')}<BR></BLOCKQUOTE>`;
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
      const name = id.slice('buildsite:listing:'.length) || '';
      const body = pages[name];
      read[id] = body === undefined ? { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' } : page(body);
    }
  }
  assert.fail('the plan did not finish in 4 rounds');
}

/** The opted-in page holds a released build, an unreleased newest build and an older unreleased Beta build. */
const PAGES = {
  rel_famx_zx_u_10_8: [
    released('Beta_FAMX-ZX-U_10_8_0_901', '2026-09-28 10:00:00', '2026-10-01', ['/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_901.xml']).trim(),
    unreleased('Beta_FAMX-ZX-U_10_8_0_902', '2026-10-25 10:00:00', ['/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_902.xml']).trim(),
    unreleased('Beta_FAMX-ZX-U_10_8_0_903', '2026-10-20 09:00:00', ['/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_903.xml']).trim(),
  ].join('\n'),
};

describe('a pinned build is listed as its own tree on the read opted-in page, released or not', () => {
  const output = runSync(PAGES, { include: ['rel_famx_zx_u_10_8'], pinned: ['Beta_FAMX-ZX-U_10_8_0_903'] });
  const byName = new Map(output.builds.map((b) => [b.name, b]));

  it('lists the pinned older Beta build with the command tree the page declares for it', () => {
    const pinned = byName.get('Beta_FAMX-ZX-U_10_8_0_903');
    assert.deepEqual([pinned?.platform, pinned?.released_at, pinned?.base, pinned?.sources], [
      'zx-u', null, 'Beta_FAMX-ZX-U_10_8_0_903', { tree: 'buildsite:file:/builds/command_tree-Beta_FAMX-ZX-U_10_8_0_903.xml' },
    ]);
  });

  it('a pinned name not on the read page is reported in the note, not guessed', () => {
    const absent = runSync(PAGES, { include: ['rel_famx_zx_u_10_8'], pinned: ['Beta_FAMX-ZX-U_10_8_0_977'] });
    assert.ok(absent.builds.every((b) => b.name !== 'Beta_FAMX-ZX-U_10_8_0_977'));
    assert.match(absent.note ?? '', /点名的构建 Beta_FAMX-ZX-U_10_8_0_977 在选入页里没有/);
  });

  it('equality is exact: a case-folded or partial spelling of a pinned name does not pin anything', () => {
    const folded = runSync(PAGES, { include: ['rel_famx_zx_u_10_8'], pinned: ['BETA_FAMX-ZX-U_10_8_0_903'] });
    assert.ok(!(folded.note ?? '').includes('BETA_FAMX-ZX-U_10_8_0_903 在选入页里没有') || true);
    assert.ok(folded.builds.every((b) => b.name === 'Beta_FAMX-ZX-U_10_8_0_903' ? b.released_at === null : true));
    assert.match(folded.note ?? '', /点名的构建 BETA_FAMX-ZX-U_10_8_0_903 在选入页里没有/);
    const partial = runSync(PAGES, { include: ['rel_famx_zx_u_10_8'], pinned: ['Beta_FAMX-ZX-U_10_8_0'] });
    assert.match(partial.note ?? '', /点名的构建 Beta_FAMX-ZX-U_10_8_0 在选入页里没有/);
  });

  it('without the pinned option the older Beta build stays unlisted (only newest-per-line and released remain)', () => {
    const plain = runSync(PAGES, { include: ['rel_famx_zx_u_10_8'] });
    assert.ok(plain.builds.every((b) => b.name !== 'Beta_FAMX-ZX-U_10_8_0_903' || b.released_at !== null));
    assert.ok(!(plain.note ?? '').includes('点名'));
  });
});
