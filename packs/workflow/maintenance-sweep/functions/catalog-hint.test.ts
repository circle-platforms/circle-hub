// 绑定的影响视图必须限定到命令目录（catalog=commands@1，决定 11）：没有带或带了别的目录的视图在投影时拒绝，
// 不再只给一句提示；带 catalog=commands@1 的视图照常投影。视图的 catalog 字段也照名字@主版本号核验。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectItems } from './test-support.ts';
import { buildImpact, SOURCE } from './test-support.ts';

const input = (model: unknown): unknown => ({ slot: 'impact', external: null, sha256: SOURCE, media_type: 'application/json', parser: 'json@1', model, meta: null });
const tryProject = (view: { [key: string]: unknown }) => projectItems({ inputs: [input(view)], parameters: {}, context: {} }) as { groups?: Array<{ kind: string }>; error?: { code: string; message: string; fix: string } };

describe('绑定视图的目录限定', () => {
  it('视图没有 catalog 字段：投影拒绝并给出修正说明', () => {
    const out = tryProject(buildImpact([], { catalog: null }));
    assert.equal(out.error?.code, 'maintenance-sweep.catalog');
    assert.match(out.error?.message ?? '', /catalog=commands@1/);
    assert.match(out.error?.fix ?? '', /catalog=commands@1/);
  });

  it('视图带了别的目录：投影拒绝', () => {
    const out = tryProject(buildImpact([], { catalog: 'behaviour@1' }));
    assert.equal(out.error?.code, 'maintenance-sweep.catalog');
    assert.match(out.error?.message ?? '', /commands@1/);
  });

  it('视图带 catalog=commands@1：照常投影，没有 catalog-hint', () => {
    const out = tryProject(buildImpact([], { catalog: 'commands@1' }));
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    assert.equal((out.groups ?? []).some((group) => group.kind === 'catalog-hint'), false, JSON.stringify(out.groups));
  });

  it('catalog 字段不是目录名：视图按格式拒绝', () => {
    const out = tryProject(buildImpact([], { catalog: 'not a catalog' }));
    assert.equal(out.error?.code, 'maintenance-sweep.not_a_view');
    assert.match(out.error?.message ?? '', /目录/);
  });
});
