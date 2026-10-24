// The device display spelling alias (the apv-device-spelling task): a build with its own tree is listed with the
// spelling a device's version display shows (the pack's naming declaration, C07 R[9]: every `_` becomes `.`, nothing
// else) as its verified alias — name-only, base the build itself, no sources of its own — so a device version probe
// comparing the extracted value against the locked build and its verified aliases recognises it. The vendor prefix is
// the executor's extraction business, not the pack's. All names are synthetic (platform zx-u, line 10.8); addresses are
// in 192.0.2.0/24.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { html, latin1 } from '../testing/test-support.ts';
import { INDEX_ID } from './sources.ts';
import { planBuilds } from './sync.ts';
import { chooseBuild } from './select.ts';

type Read = { ok: boolean; media_type: string | null; parser: string | null; model: unknown; reason: string | null };
const HTML_TYPE = 'text/html; charset=ISO-8859-1';
const INDEX = () => html(latin1('<html><body><A HREF=http://192.0.2.10/builds/rel_apv_10_8.html>rel_apv_10_8 builds</A><BR><BR></body></html>'));
const released = (name: string, built: string, date: string, links: string[]): string =>
  `<font color=red>${name} (build on  ${built} ): Released on ${date} </font> </br> <BLOCKQUOTE> ${links.map((href) => `<A href=${href}>http://192.0.2.10${href}</A>`).join('<BR>')}<BR></BLOCKQUOTE>`;
const page = (body: string): Read => ({ ok: true, media_type: HTML_TYPE, parser: 'html@1', model: html(latin1(`<html><body>${body}</body></html>`)), reason: null });

function runSync(pages: Record<string, string>, options: Record<string, unknown>): ReturnType<typeof planBuilds> {
  const read: Record<string, Read> = { [INDEX_ID]: { ok: true, media_type: HTML_TYPE, parser: 'html@1', model: INDEX(), reason: null } };
  for (let round = 1; round <= 4; round++) {
    const output = planBuilds({ round, options, read, known: [] });
    assert.ok(SyncPlanOutput.safeParse(output).success, `round ${round}`);
    if (output.done) return output;
    for (const id of output.fetch) {
      const name = id.slice('buildsite:listing:'.length) || '';
      const body = pages[name];
      read[id] = body === undefined ? { ok: false, media_type: null, parser: null, model: null, reason: 'HTTP 404' } : page(body);
    }
  }
  assert.fail('the plan did not finish in 4 rounds');
}

const PAGES = {
  rel_apv_10_8: released('Beta_APV_10_8_0_901', '2026-10-20 10:00:00', '2026-10-22', ['/builds/command_tree-Beta_APV_10_8_0_901.xml']).trim(),
};

describe('a build with its own tree lists its device display spelling as a verified alias', () => {
  const output = runSync(PAGES, { });
  const byName = new Map(output.builds.map((b) => [b.name, b]));

  it('lists the alias name-only with the build as its base and the same line and platform', () => {
    const alias = byName.get('Beta.APV.10.8.0.901');
    assert.deepEqual([alias?.family, alias?.line, alias?.platform, alias?.base, alias?.sources], ['APV', '10.8', null, 'Beta_APV_10_8_0_901', {}]);
    const build = byName.get('Beta_APV_10_8_0_901');
    assert.deepEqual([build?.base, typeof build?.sources.tree], ['Beta_APV_10_8_0_901', 'string']);
  });

  it('the build choice never selects the alias over the build', () => {
    const chosen = chooseBuild({ candidates: output.builds.map((b) => ({ ...b, root: 'r'.repeat(64) })), line: '10.8', request: {} });
    assert.equal(chosen.build, 'Beta_APV_10_8_0_901');
    assert.ok((chosen.alternatives ?? []).every((name) => name !== 'Beta.APV.10.8.0.901'), JSON.stringify(chosen.alternatives));
  });
});
