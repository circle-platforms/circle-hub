// The synthetic install profile against the product's asset grammar: every extension the profile lets the upgrade case take
// is one famx's famx-assets@2 reads as the image of a build on a listing page, and the example request names that image.
// At run time the check reads only the profile frozen with the run; this test is where the two are kept consistent for the
// synthetic product (the deployment's real profile is checked the same way by whoever publishes it).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import PROFILE from '../examples/bed-install-profile.json' with { type: 'json' };
import REQUEST from '../examples/install-request.json' with { type: 'json' };
import START from '../examples/start-run.json' with { type: 'json' };
import TABLE from '../policies/install.json' with { type: 'json' };
import { parseListing } from '../../../product/famx/api.ts';
import { imageVersion, readProfile, readRequest, readTable, versionOfBuild } from './common.ts';

/** A one-entry listing page as the html@1 parser models it: the build line and one link to `file`. */
function listing(build: string, file: string) {
  return {
    charset: 'utf-8',
    title: null,
    blocks: [{ tag: 'body', text: `${build} (build on 2026-01-01 10:00:00 ): Released on 2026-01-02`, flags: [], links: [0], range: null }],
    links: [{ href: file, text: 'image', block: 0, wrappers: [], range: null }],
  };
}

describe('the synthetic install profile', () => {
  it('has the declared shape and binds by the default document name in the example run', () => {
    const table = readTable(TABLE);
    assert.ok(table);
    const read = readProfile(PROFILE, table.profile_schema);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual((START.inputs as Record<string, unknown>).profile, { external: 'doc:doc:bed-install-profile' });
  });

  it('lists only extensions that famx-assets@2 reads as a build image', () => {
    const build = REQUEST.build;
    for (const extension of PROFILE.image_extensions) {
      const file = `FAMXOS-${build}.${extension}`;
      const parsed = parseListing(listing(build, file) as unknown as Parameters<typeof parseListing>[0]);
      assert.equal(parsed.builds.length, 1, JSON.stringify(parsed.warnings));
      assert.equal(parsed.builds[0].files.image?.name, file, `${extension}: ${JSON.stringify(parsed.warnings)}`);
      assert.ok(!parsed.warnings.some((warning) => warning.includes('资产角色未核对')), JSON.stringify(parsed.warnings));
    }
  });

  it('the example request names the image famx reads for its build, and the upgrade case reads that build from it', () => {
    const read = readRequest(REQUEST);
    assert.ok(read.ok);
    const parsed = parseListing(listing(read.request.build, read.request.image) as unknown as Parameters<typeof parseListing>[0]);
    assert.equal(parsed.builds[0]?.name, read.request.build);
    assert.equal(parsed.builds[0]?.files.image?.name, read.request.image);
    assert.equal(imageVersion(read.request.image, PROFILE.image_extensions), versionOfBuild(read.request.build));
  });
});
