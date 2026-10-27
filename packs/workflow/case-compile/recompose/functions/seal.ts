// Default run subject is supplied by Hub: every frozen item plus the actually submitted slots.
export default function (input: any) {
    const items = input.subject?.items ?? [], expected = items.map((i: any) => i.id), actual = items.filter((i: any) => i.slots?.record?.length === 1), missing = items.filter((i: any) => !i.slots?.record?.length).map((i: any) => i.id), wrong = actual.filter((i: any) => i.slots.record[0].data?.case?.source_ref !== i.fields?.source_ref || i.slots.record[0].data?.case?.node !== i.fields?.node).map((i: any) => i.id);
    if (wrong.length || new Set(expected).size !== expected.length)
        return [{ verdict: 'refute', code: 'recompose.atom_dropped', statement: '分片条目与冻结来源不是一一对应；重组模型在封批之前按原集合补回，不改原文', grounds: [], tier: 'blocking', data: { wrong, missing_fact: '条目来源身份不相等', next_action: '按冻结集合重交', owner: '重组模型', due: '封批之前' } }];
    if (missing.length)
        return [{ verdict: 'unknown', reason: 'missing_input', missing: '完整任务集合尚未逐项登记；等待重组模型在封批之前补齐 ' + missing.join('、'), statement: '分片不能独立封整批，按实际冻结全集计算缺案', grounds: [], tier: 'blocking', data: { total: expected.length, supplied: actual.length, missing, next_action: '读取已存提交并汇总实际全集后重交', owner: '重组模型', due: '封批之前' } }];
    return [{ verdict: 'support', statement: '实际提交与冻结任务全集一一对应；完整产物还要求每个条目所有要求项均满足', grounds: [], tier: 'blocking', data: { total: expected.length, supplied: actual.length, missing: [] } }];
}
