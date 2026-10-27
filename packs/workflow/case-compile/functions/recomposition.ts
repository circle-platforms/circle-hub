import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
// Consume an admitted case artifact, not a review receipt or a self-described upload.
import { acceptedPair, object } from './recompose-evidence.ts';
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
export function recompositionGaps(slots: PlanSlots, proof: any, manifestSha?: string): Array<{
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
            note('映射含重组产物之外的期望位', 'refute');
        for (const id of row.assertions) {
            if (assigned.has(id))
                note('不同期望位不能共用一个断言替代履约', 'refute');
            assigned.add(id);
        }
    }
    for (const slot of proof.record.expectation_slots) {
        const rows = use.slots.filter(r => r.slot === slot.slot);
        if (rows.length !== 1 || !rows[0].assertions.length) {
            note('重组期望位 ' + slot.slot + ' 缺独立断言履约；等待编写模型提交前补齐');
            continue;
        }
        const atom = proof.record.atoms.find((a: any) => a.id === slot.atom);
        for (const id of rows[0].assertions) {
            const e = expects.find(e => e.identity === id);
            if (!e || e.quote.reference !== atom?.quote_ref || e.quote.text !== atom?.text || slot.criterion_id !== undefined && e.criterion !== slot.criterion_id)
                note('重组期望位 ' + slot.slot + ' 的断言、逐字原子或判据 id 不相等', 'refute');
        }
    }
    if (use.rebindings.length !== slots.replacements.length)
        note('重绑定账与 replacements 缺一一对应；等待编写模型提交前补账');
    for (const r of use.rebindings) {
        if (!r.authority || !r.source_of_value) {
            note('重绑定缺 source_of_value/authority；等待编写模型和台架维护者提交前补齐');
            continue;
        }
        if (!slots.replacements.some(p => p.case === r.from && p.bed === r.to) || r.authority !== 'src:' + manifestSha)
            note('重绑定 from/to 或 authority 不等于类型化替换及冻结清单', 'refute');
        if (!proof.record.ledgers.concretizations.some((c: any) => c.slot === r.slot && c.value === r.from && c.value_ref === r.source_of_value))
            note('缺原具体化值与原始取值来源；等待产品包作者及重组模型补齐，不能覆盖原文账');
    }
    return issues;
}
