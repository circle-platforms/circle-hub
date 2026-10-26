// The device display spelling alias (the famx-device-spelling task): a build with its own tree is listed with the
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
const INDEX = () => html(latin1('<html><body><A HREF=http://192.0.2.10/builds/rel_famx_10_8.html>rel_famx_10_8 builds</A><BR><BR></body></html>'));
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
  rel_famx_10_8: released('Beta_FAMX_10_8_0_901', '2026-10-20 10:00:00', '2026-10-22', ['/builds/command_tree-Beta_FAMX_10_8_0_901.xml']).trim(),
};

describe('a build with its own tree lists its device display spelling as a verified alias', () => {
  const output = runSync(PAGES, { });
  const byName = new Map(output.builds.map((b) => [b.name, b]));

  it('lists the alias name-only with the build as its base and the same line and platform', () => {
    const alias = byName.get('Beta.FAMX.10.8.0.901');
    assert.deepEqual([alias?.family, alias?.line, alias?.platform, alias?.base, alias?.sources], ['FAMX', '10.8', null, 'Beta_FAMX_10_8_0_901', {}]);
    const build = byName.get('Beta_FAMX_10_8_0_901');
    assert.deepEqual([build?.base, typeof build?.sources.tree], ['Beta_FAMX_10_8_0_901', 'string']);
  });

  it('the build choice never selects the alias over the build', () => {
    const chosen = chooseBuild({ candidates: output.builds.map((b) => ({ ...b, root: 'r'.repeat(64) })), line: '10.8', request: {} });
    assert.equal(chosen.build, 'Beta_FAMX_10_8_0_901');
    assert.ok((chosen.alternatives ?? []).every((name) => name !== 'Beta.FAMX.10.8.0.901'), JSON.stringify(chosen.alternatives));
  });
});

describe('device aliases follow the retained build set',()=>{
 it('does not leave a device alias when the base is withheld for missing structural case metadata',()=>{
  const output=runSync(PAGES,{case_index:true,min_line:'10.8'});
  assert.ok(output.builds.every(build=>build.base!=='Beta_FAMX_10_8_0_901'),'neither withheld base nor its alias is offered');
  assert.match(output.note??'',/没有列出|不列构建/);
 });
 it('keeps an unpublished own-tree alias for a caller that explicitly synchronizes unpublished builds',()=>{
  const name='Beta_FAMX_10_8_0_902';
  const body=`${name} (build on 2026-10-23 10:00:00 ): </br><BLOCKQUOTE><A href=/builds/command_tree-${name}.xml>tree</A></BLOCKQUOTE>`;
  const output=runSync({rel_famx_10_8:body},{});
  const base=output.builds.find(build=>build.name===name),alias=output.builds.find(build=>build.name===name.replaceAll('_','.'));
  assert.ok(base&&alias);assert.equal(base.released_at,null);assert.equal(alias.released_at,null);assert.equal(alias.base,name);assert.deepEqual(alias.sources,{});
 });
});
