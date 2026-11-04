// The bug list read (decision 111): the key's filters, the one GET it plans and the rows it projects, with what the
// answer does and does not establish. Synthetic records only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bugListPlan, bugListProject, parseBugListKey } from './plm.ts';

const external = (key: string) => ({ external: { type: 'bug-list', key } });

test('a key is name=value pairs joined by &, from the whitelist, each once, values URI-decoded and checked', () => {
  assert.deepEqual(parseBugListKey('assignedTo=synthetic.user&status=active'), { filters: { assignedTo: 'synthetic.user', status: 'active' } });
  assert.deepEqual(parseBugListKey('product=9&lastEditedDate_start=2026-10-01%2000%3A00%3A00'), { filters: { product: '9', lastEditedDate_start: '2026-10-01 00:00:00' } });
  for (const bad of ['', 'page=2', 'assignedTo=a&assignedTo=b', 'status=open', 'severity=9', 'assignedTo', 'assignedTo=a%2', 'product=0x1c', 'assignedTo=a b']) {
    assert.ok('error' in parseBugListKey(bad), bad);
  }
  assert.match((parseBugListKey('page=2') as { error: string }).error, /不认识的过滤条件“page”.*名取 product、status、severity、assignedTo、openedBy、lastEditedDate_start、lastEditedDate_end/);
});

test('the plan is one GET of the list route with the filters as its query; a bad key plans nothing', () => {
  assert.deepEqual(bugListPlan(external('assignedTo=synthetic.user')), { requests: [{ key: 'list', route: 'bug-list', query: { assignedTo: 'synthetic.user' } }], original: 'list', done: true });
  assert.deepEqual(bugListPlan(external('page=2')), { requests: [], done: true });
  assert.deepEqual(bugListPlan({ external: { type: 'bugs', key: 'assignedTo=a' } }), { requests: [], done: true });
});

test('the projection keeps every row as given, counts them and says what the list does not establish', () => {
  const rows = [
    { id: 910001, title: '合成缺陷一', status: 'active', severity: 3, assignedTo: 'synthetic.user', deleted: '0', nested: { dropped: true } },
    { id: '910002', title: '合成缺陷二', status: 'resolved', severity: 2, assignedTo: 'synthetic.user', deleted: '1' },
  ];
  for (const json of [{ code: 1000, msg: 'success', data: rows }, rows]) {
    const out = bugListProject({ ...external('assignedTo=synthetic.user'), responses: { list: { ok: true, json } }, original: 'list' }) as { note: string; artifacts: Array<{ name: string; json: any }> };
    const content = out.artifacts.find((a) => a.name === 'content')!.json;
    assert.deepEqual(content.filters, { assignedTo: 'synthetic.user' });
    assert.equal(content.count, 2);
    assert.deepEqual(content.bugs[0], { id: 910001, title: '合成缺陷一', status: 'active', severity: 3, assignedTo: 'synthetic.user', deleted: '0' }, 'scalar fields only, nothing renamed');
    assert.equal(content.bugs[1].deleted, '1', 'a deleted row is shown, not dropped: which rows count is the reader\'s call');
    assert.match(out.note, /这次应答共 2 行；查询服务的列表接口不分页（2026-10-12 观察），Hub 没有核对服务端是否另有行数上限/);
    assert.match(out.note, /空列表只说明读取时刻按这些条件没有匹配，不说明没有/);
  }
  const empty = bugListProject({ ...external('assignedTo=nobody'), responses: { list: { ok: true, json: { code: 1000, data: [] } } }, original: 'list' }) as { artifacts: Array<{ name: string; json: any }> };
  assert.equal(empty.artifacts[0]!.json.count, 0);
  assert.deepEqual(bugListProject({ ...external('assignedTo=a'), responses: { list: { ok: true, json: { code: 401, msg: 'Token不存在.' } } }, original: 'list' }), { error: { code: 'plm.no_records', message: '缺陷列表不是数组：应答既不是数组也没有数组形的 data；核对原始应答后重读' } });
  assert.equal((bugListProject({ ...external('page=1'), responses: {}, original: 'list' }) as { error: { code: string } }).error.code, 'plm.invalid_key');
});
