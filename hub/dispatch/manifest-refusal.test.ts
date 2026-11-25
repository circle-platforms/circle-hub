import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedDispatch } from './accepted.ts';
import { setup } from './testing/context.ts';

for (const scenario of ['superseded', 'unrelated', 'historical verification', 'different target', 'shared old revision', 'shared verified revision'] as const) {
  test(scenario + ' manifest gives the administrator and member the applicable next step', async t => {
    const sameDocument = scenario !== 'unrelated';
    const c = await setup();
    t.after(() => c.close());
    const source = c.detail.run.sources.find(row => row.slot === 'synthetic-manifest')!;
    const current = c.executor.definition.manifest_sha256!;
    const old = current.slice(0, 63) + (current.endsWith('0') ? '1' : '0');
    source.external = 'doc:doc:synthetic-inventory@' + current;
    const pointer = 'doc:synthetic-inventory';
    await c.kit.pointers.move({ name: sameDocument ? pointer : 'doc:synthetic-other', expected: null, next: old, by: c.admin });
    await c.kit.pointers.move({ name: pointer, expected: sameDocument ? old : null, next: current, by: c.admin });
    if (scenario === 'historical verification') await c.kit.pointers.move({ name: pointer, expected: current, next: 'f'.repeat(64), by: c.admin });
    if (scenario.startsWith('shared')) {
      const other = scenario === 'shared old revision' ? old : current;
      await c.kit.pointers.move({ name: 'doc:synthetic-other', expected: null, next: other, by: c.admin });
    }
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition, manifest_sha256: old,
      ...(scenario === 'different target' ? { target: 'synthetic-other-target' } : {}),
    });
    for (const viewer of [c.admin, c.owner]) {
      const [note] = await acceptedDispatch(c.kit, c.service, c.run, true, undefined, viewer);
      assert.equal(note.outcome, 'not_dispatched');
      if (scenario === 'superseded') {
        assert.doesNotMatch(note.text, /重新开始运行|先确认预订的是哪个测试环境/);
        if (viewer === c.admin) {
          assert.match(note.text, /现在可以做：用 circle-hub executor update 按清单的现行修订重新登记执行器/);
          assert.match(note.text, /清单由普通变量指定时更新该变量/);
          assert.ok(note.text.includes(`逐条对照：circle-hub job explain-release --run ${c.run} --executor ${c.executor.id}`));
          assert.equal(note.next_action, '核对本次预订和核验结果；需要管理员处理的，联系管理员核对');
        } else {
          assert.match(note.text, /请管理员按清单的现行修订重新登记执行器/);
          assert.doesNotMatch(note.text, /circle-hub|逐条对照/);
          assert.equal(note.next_action, '请管理员按清单的现行修订重新登记执行器');
        }
      } else {
        assert.match(note.text, viewer === c.admin ? /按执行器声明的测试环境和清单重新开始运行/ : /先确认预订的是哪个测试环境/);
        assert.doesNotMatch(note.text, /按清单的现行修订重新登记/);
      }
    }
    assert.deepEqual(c.calls, []);
  });
}
