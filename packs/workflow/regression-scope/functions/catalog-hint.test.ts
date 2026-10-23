// 绑定的影响视图没有限定目录（catalog 字段）时，结论里有一句提示：只按条目种类比，可能混进其他生产器的条目；
// 带 catalog=commands@1 的视图没有这句。视图的 catalog 字段也照名字@主版本号核验。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectItems } from './test-support.ts';
import { buildImpact, SOURCE } from './test-support.ts';

const input = (model: unknown): unknown => ({ slot: 'impact', external: null, sha256: SOURCE, media_type: 'application/json', parser: 'json@1', model, meta: null });
const project = (view: { [key: string]: unknown }) => projectItems({ inputs: [input(view)], parameters: {}, context: {} }) as { groups: Array<{ kind: string; message?: string }> };

describe('绑定视图的目录限定提示', () => {
  it('视图没有 catalog 字段：结论带一句提示', () => {
    const out = project(buildImpact([]));
    const hint = out.groups.find((group) => group.kind === 'catalog-hint');
    assert.ok(hint, JSON.stringify(out.groups));
    assert.match(hint.message ?? '', /没有限定目录/);
    assert.match(hint.message ?? '', /catalog=commands@1/);
  });

  it('视图带 catalog 字段：没有这句提示', () => {
    const out = project(buildImpact([], { catalog: 'commands@1' }));
    assert.equal(out.groups.some((group) => group.kind === 'catalog-hint'), false, JSON.stringify(out.groups));
  });

  it('catalog 字段不是目录名：视图被拒', () => {
    const out = projectItems({ inputs: [input(buildImpact([], { catalog: 'not a catalog' }))], parameters: {}, context: {} }) as { error?: { code: string; message: string } };
    assert.equal(out.error?.code, 'regression-scope.not_a_view');
    assert.match(out.error?.message ?? '', /目录/);
  });
});
