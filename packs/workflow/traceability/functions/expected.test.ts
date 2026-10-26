// Tests of the expected sources function for traceability.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProjectedItem } from '../../../../contracts/src/pack.ts';
import { expectedSources, MAX_BUGS_PER_SOURCE } from './expected.ts';

const makeItem = (id: string, systems: string[] = ['plm']): ProjectedItem => ({
  id,
  label: `缺陷 ${id}`,
  location: { slot: 'defects', source: 'src', parser: 'json@1', selector: `p/entries/${id}` },
  fields: { bug: id, systems },
});

describe('traceability expectedSources', () => {
  test('groups defect ids into batches of at most 50, sorted numerically and deduplicated', () => {
    const items = [
      makeItem('71002'),
      makeItem('71001'),
      makeItem('071001'), // normalises to 71001
      makeItem('71010'),
    ];
    const out = expectedSources({ items });
    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0].external, 'plm:bugs:71001+71002+71010');
    assert.equal(out.sources[0].role, 'expected');
    assert.match(out.sources[0].reason, /缺陷系统/);
  });

  test('splits more than 50 defect ids into multiple expected sources', () => {
    const items = Array.from({ length: 125 }, (_, i) => makeItem(String(i + 1)));
    const out = expectedSources({ items });
    assert.equal(out.sources.length, 3);

    const firstIds = out.sources[0].external.replace('plm:bugs:', '').split('+');
    assert.equal(firstIds.length, MAX_BUGS_PER_SOURCE);
    assert.equal(firstIds[0], '1');
    assert.equal(firstIds[49], '50');

    const secondIds = out.sources[1].external.replace('plm:bugs:', '').split('+');
    assert.equal(secondIds.length, MAX_BUGS_PER_SOURCE);
    assert.equal(secondIds[0], '51');
    assert.equal(secondIds[49], '100');

    const thirdIds = out.sources[2].external.replace('plm:bugs:', '').split('+');
    assert.equal(thirdIds.length, 25);
    assert.equal(thirdIds[0], '101');
    assert.equal(thirdIds[24], '125');
  });

  test('only queries defects where systems includes plm; excludes bugzilla-only and unknown systems', () => {
    const items = [
      makeItem('160001', ['bugzilla']),
      makeItem('71001', ['plm']),
      makeItem('71002', ['plm', 'bugzilla']),
      makeItem('71003', []),
    ];
    const out = expectedSources({ items });
    assert.equal(out.sources.length, 1);
    const queriedIds = out.sources[0].external.replace('plm:bugs:', '').split('+');
    assert.deepEqual(queriedIds, ['71001', '71002']);
    assert.ok(!queriedIds.includes('160001'));
    assert.ok(!queriedIds.includes('71003'));
  });

  test('handles empty or malformed inputs gracefully', () => {
    assert.deepEqual(expectedSources(null), { sources: [], warnings: [] });
    assert.deepEqual(expectedSources({}), { sources: [], warnings: [] });
    assert.deepEqual(expectedSources({ items: [] }), { sources: [], warnings: [] });
  });
});
