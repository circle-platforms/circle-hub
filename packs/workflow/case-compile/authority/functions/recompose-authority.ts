import SHAPE from '../tables/recompose-product.schema.json' with { type: 'json' };
import { schema } from './schema.ts';
// Verifies published product bytes and their original publication; no product-specific rule lives in core.
import T from '../tables/recompose-format.json' with { type: 'json' };
import { envelope, object } from './recompose-evidence.ts';
export function productAuthority(inputs: any[], context: any): {
    authority: any | null;
    missing: string;
    invalid?: boolean;
} {
    const find = (slot: string) => inputs.find(i => i.slot === slot), version = envelope(find('product_version'), 'pack_version'), publication = envelope(find('publication'), 'authorization'), data = find('product_data');
    const missing = '缺与本轮产品包摘要一致的已发布 product.json 及发布凭证；等待产品包作者/发布管理员在重新提交之前绑定 product_version、publication、product_data，不接受模型自述';
    if (!version || !publication || !data || !object(data.model))
        return { authority: null, missing };
    const v = version.body, p = publication.body, file = v.manifest?.files?.find((f: any) => f.path === 'product.json');
    if (v.kind !== 'product' || v.pack !== context.product || v.digest !== context.product_pack_digest || p.permission !== 'publish' || p.revoked !== false || p.bound !== v.digest || p.object !== v.pack + '@' + v.version || !file || file.sha256 !== data.sha256 || data.model.id !== v.pack)
        return { authority: null, missing, invalid: true };
    const declarations = (data.model.producers ?? []).flatMap((producer: any) => producer.params?.recompose?.schema === T.product ? [producer.params.recompose] : []);
    if (declarations.length !== 1)
        return { authority: null, missing: '缺唯一 recompose-product@1 产品声明；等待产品包作者在生产器 params.recompose 中声明规范来源、适用版本和参数用途，重新发布后重开，不采用工作包默认排序' };
    const policy = declarations[0];
    if (!schema(SHAPE).safeParse(policy).success)
        return { authority: null, missing: '产品规范来源声明缺形状、用途或裁决角色；等待产品包作者在重新提交之前补 recompose-product@1 后重发' };
    const governing = Array.isArray(policy.governing) ? policy.governing.filter((g: any) => g.applies_to?.lines?.includes(context.line) && (g.applies_to?.all_builds === true || g.applies_to?.builds?.includes(context.build))) : [];
    if (!governing.length || !Array.isArray(policy.declarations) || !Array.isArray(policy.parameters) || !Array.isArray(policy.values))
        return { authority: null, missing: '缺适用于本版本/构建的规范来源与用途声明；等待产品包作者在重新提交之前补闭集及适用范围后重发' };
    return { authority: { ...policy, governing, scope: { product: context.product, product_pack_digest: context.product_pack_digest, line: context.line, build: context.build, root: context.root }, publication: publication.reference, product_record: version.reference, owner: v.publisher }, missing: '' };
}
