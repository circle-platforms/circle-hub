import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
// Consume an admitted case artifact, not a review receipt or a self-described upload.
import { acceptedPair, acceptsPack, envelope, object } from './recompose-evidence.ts';
import T from '../tables/recompose-format.json' with { type: 'json' };
import type { PlanSlots } from './slots.ts';
export function admittedRecomposition(runInput: any, resultInput: any, context: any, source: string, node: string) {
    const pair = acceptedPair(runInput, resultInput, T.packs.stage);
    if (!pair || pair.run.product !== context.product || pair.run.root !== context.root || pair.run.product_pack_digest !== context.product_pack_digest)
        return null;
    const target = pair.run.items?.find((i: any) => i.fields?.source_ref === source && i.fields?.node === node);
    if (!target)
        return null;
    const row = Object.values(pair.result.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((i: any) => i.item === target.id), requirement = row?.requirements?.find((r: any) => r.requirement === 'record');
    if (requirement?.status !== 'satisfied')
        return null;
    const claim = requirement.claims?.find((c: any) => c.warrant?.producer === 'model' && c.validity?.status === 'valid' && c.statement?.data?.schema === T.record && c.statement.data.case.source_ref === source && c.statement.data.case.node === node);
    const record = claim?.statement.data;
    if (!record || record.status !== 'complete' || (record.predecessor ?? null) !== (pair.run.predecessor ?? null))
        return null;
    return { record, receipt: pair.reference, run: pair.run.run, source, conditional_on_judgment: true };
}
/**
 * Why the bound recomposition was not admitted (called after admittedRecomposition returned null), one of its conditions at a
 * time and in the same order, in words the writer can act on. Without it every one of these collapsed into one sentence that sent
 * a model in run 13 to wait for an "independent reviewer" when it had bound the same result record in both slots.
 */
export function recompositionProblem(runInput: any, resultInput: any, context: any, source: string, node: string): string {
    const run = envelope(runInput, 'run'), result = envelope(resultInput, 'validation_result');
    const kindOf = (bound: any) => object(bound) ? (bound.meta?.kind ?? bound.model?.kind ?? '原件') : '未绑定';
    const named = (bound: any) => object(bound) && typeof bound.meta?.record === 'string' ? `rec:${bound.meta.record.slice(0, 12)}…` : '';
    const same = object(runInput) && object(resultInput) && typeof runInput.meta?.record === 'string' && runInput.meta?.record === resultInput.meta?.record;
    const how = 'recomposition_run 绑重组运行的运行记录（rec:），recomposition_result 绑重组运行号（run_…，Hub 换成该运行已受理的结果）';
    if (!run) return `recomposition_run 绑的是 ${kindOf(runInput)} 记录 ${named(runInput)}，不是重组运行的运行记录${same ? '：两个槽写成了同一个引用' : ''}；${how}`;
    if (!result) return `recomposition_result 绑的是 ${kindOf(resultInput)} ${named(resultInput)}，不是重组运行已受理的结果；${how}`;
    if (!acceptsPack(run.body.pack, T.packs.stage)) return '这份重组后的用例使用的技能版本不受支持；请使用当前技能重新做用例重组';
    if (result.body.schema !== 'validation@1' || result.body.run !== run.body.run) return `recomposition_result 不是重组运行 ${run.body.run} 的结果（它属于 ${result.body.run}）`;
    if (result.body.acceptance !== 'accepted') return `重组运行 ${run.body.run} 的这份结果没有被受理；按它的回执改正重交，受理后再绑定`;
    if (result.body.locks?.pack !== run.body.pack || result.body.locks?.pack_digest !== run.body.pack_digest) return `重组结果锁定的包和重组运行 ${run.body.run} 的包不一致`;
    if (run.body.product !== context.product || run.body.root !== context.root || run.body.product_pack_digest !== context.product_pack_digest) return `重组运行 ${run.body.run} 的产品、版本根或产品包与本运行不同；按本运行的产品和构建重新重组`;
    const target = run.body.items?.find((i: any) => i.fields?.source_ref === source && i.fields?.node === node);
    if (!target) return `重组运行 ${run.body.run} 里没有这条用例（脑图节点 ${node}）；用同一份脑图原件重组`;
    const row = Object.values(result.body.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((i: any) => i.item === target.id);
    if (row?.requirements?.find((r: any) => r.requirement === 'record')?.status !== 'satisfied') return `重组运行 ${run.body.run} 里这条用例的 record 要求项没有满足；按重组回执补齐后重交`;
    return '重组记录不完整，或它的前驱与重组运行不同；按重组回执补齐后重交';
}

export function recompositionGaps(slots: PlanSlots, proof: any): Array<{
    message: string;
    verdict: Extract<Verdict, 'unknown' | 'refute'>;
}> {
    if (!proof)
        return [];
    const issues: Array<{
        message: string;
        verdict: Extract<Verdict, 'unknown' | 'refute'>;
    }> = [], use = slots.recomposition, note = (message: string, verdict: Extract<Verdict, 'unknown' | 'refute'> = 'unknown') => issues.push({ message, verdict });
    if (!use) {
        note('缺显式重组消费身份；等待编写模型在编写提交前填写已受理 receipt 和 case_id');
        return issues;
    }
    if (use.receipt !== proof.receipt || use.case_id !== proof.record.case.id) {
        note('receipt 或 case_id 不等于实际受理重组记录，不能用评审或别案替代', 'refute');
        return issues;
    }
    const expects = slots.expects.map((e, i) => ({ ...e, identity: e.id ?? String(i + 1) })), assigned = new Set<string>();
    for (const row of use.slots) {
        if (!proof.record.expectation_slots.some((s: any) => s.slot === row.slot))
            note('对应关系里有重组记录之外的期望判断依据', 'refute');
        for (const id of row.assertions) {
            if (assigned.has(id))
                note('不同的期望判断依据不能共用一个断言', 'refute');
            assigned.add(id);
        }
    }
    for (const slot of proof.record.expectation_slots) {
        const rows = use.slots.filter(r => r.slot === slot.slot);
        if (rows.length !== 1 || !rows[0].assertions.length) {
            note('重组记录里的期望判断依据 ' + slot.slot + ' 还没有自己的断言；编写模型提交前补齐');
            continue;
        }
        const atom = proof.record.atoms.find((a: any) => a.id === slot.atom);
        for (const id of rows[0].assertions) {
            const e = expects.find(e => e.identity === id);
            if (!e || e.quote.reference !== atom?.quote_ref || e.quote.text !== atom?.text || slot.criterion_id !== undefined && e.criterion !== slot.criterion_id)
                note('重组记录里的期望判断依据 ' + slot.slot + ' 的断言、用例原句的原文或判据 id 对不上', 'refute');
        }
    }
    return issues;
}
