// withRevision: the identity a run's sources record carries the revision the Hub read. An id already pinned (a trailing
// root or root pair, or exactly the revision read) is never pinned twice; a literal @ inside the id (the catalog name of
// a knowledge view) is percent-escaped, so the pinned identity still fits system:type:id[@revision] and the view parser
// decodes it back to the same id.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { withRevision } from './inputs.ts';

const FROM = 'a'.repeat(64);
const TO = 'b'.repeat(64);
const PAIR = `${FROM}..${TO}`;
const CATALOGED = 'knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition&catalog=commands@1';

describe('withRevision', () => {
  test('带 catalog=commands@1 的影响视图标识：标识内的 @ 转义后拼上根对修订', () => {
    assert.equal(withRevision(CATALOGED, PAIR), `knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition&catalog=commands%401@${PAIR}`);
  });

  test('已经带修订的标识不重复拼', () => {
    assert.equal(withRevision(`${CATALOGED}@${PAIR}`, PAIR), `${CATALOGED}@${PAIR}`, '根对修订');
    assert.equal(withRevision(`knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=defects@${FROM}`, FROM), `knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=defects@${FROM}`, '单根修订');
    assert.equal(withRevision('agile:mindmap:900301@1', '1'), 'agile:mindmap:900301@1', '标识末尾正是读到的修订');
  });

  test('没有修订的标识照原样拼', () => {
    assert.equal(withRevision('agile:mindmap:900301', '1'), 'agile:mindmap:900301@1');
    assert.equal(withRevision('knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition', PAIR), `knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition@${PAIR}`);
    assert.equal(withRevision('doc:doc:规格', '9'.repeat(64)), `doc:doc:规格@${'9'.repeat(64)}`);
  });

  test('没有读到修订或拼出来不是合法标识时照原样', () => {
    assert.equal(withRevision(CATALOGED, null), CATALOGED);
    assert.equal(withRevision('not an id', '1'), 'not an id');
  });
});
