// Scope reports observed source membership. Additional roots only decide omission here; their entries are not merged.
import { ReasonSchema, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { KnowledgeViewScope, ScopedDocument } from '../../contracts/src/views.ts';
import type { KnowledgeContext } from './context.ts';
import { CompositionView } from './composition.ts';
import { compareText } from './digest.ts';
import { sha256Hex } from '../records/api.ts';
import { KnowledgeError } from './errors.ts';
import { KnowledgeStore, INDEX, type ProduceAction } from './store.ts';
import { readProblemRows } from './problem-journal.ts';
import type { ActionBody } from '../records/api.ts';
export interface RawScope {
    roots: KnowledgeViewScope['roots'];
    additional_roots: KnowledgeViewScope['additional_roots'];
    additional_roots_declared: boolean;
    not_in_roots: ScopedDocument[];
    listed: ScopedDocument[];
    elsewhere: ScopedDocument[];
    omitted: ScopedDocument[] | null;
    pending: ScopedDocument[];
    optional: ScopedDocument[];
    unplaced_entries: number;
    unplaced_cases?: {
        from: number;
        to: number;
    };
}
async function productionOf(context: KnowledgeContext, composition: CompositionView): Promise<ProduceAction | null> {
    const row = await context.store.newest<ActionBody>({ key: 'knowledge.produce.composition', value: composition.record, kind: 'action' });
    if (row) {
        const production = KnowledgeStore.produceOf(row);
        if (production?.detail.composition === composition.record && production.detail.product === composition.body.product)
            return production;
    }
    const latest = await context.store.latestProduction(composition.body.product, composition.body.build?.name ?? null);
    if (latest?.detail.composition === composition.record)
        return latest;
    return (await context.store.productionsOfRoot(composition.body.root)).find(production => production.detail.composition === composition.record && production.detail.product === composition.body.product) ?? null;
}
export async function documentScope(context: KnowledgeContext, product: string, main: readonly CompositionView[], impact: boolean): Promise<RawScope> {
    const allMain = [...new Map(main.map(composition => [composition.record, composition])).values()];
    const extra: CompositionView[] = [];
    for (const ref of [...await context.additionalScopeRoots?.(product) ?? []].sort((a, b) => compareText(a.composition, b.composition) || compareText(a.root, b.root))) {
        const body = await context.store.composition(ref.composition);
        if (!body || body.root !== ref.root || body.product !== product)
            throw new KnowledgeError('额外根配置不可用于本产品；管理员核对根与组成后重读');
        if (!allMain.some(composition => composition.record === ref.composition) && !extra.some(composition => composition.record === ref.composition))
            extra.push(new CompositionView(context.store, ref.composition, body));
    }
    const header = (composition: CompositionView) => ({ root: composition.body.root, composition: composition.record, build: composition.body.build?.name ?? null });
    const listed = new Map<string, ScopedDocument>(), other = new Map<string, ScopedDocument>(), candidates = new Map<string, ScopedDocument>(), optional: ScopedDocument[] = [];
    let unplacedEntries = 0;
    const unplacedCases: number[] = [];
    for (const [additional, compositions] of [[false, allMain], [true, extra]] as const)
        for (const composition of compositions) {
            for (const source of await composition.sources()) {
                const into = additional ? other : listed, key = `${source.external}\0${source.sha256}`, known = into.get(key);
                if (known) {
                    if (!known.at!.includes(composition.record))
                        known.at!.push(composition.record);
                    if (!known.uses!.some(use => use.producer === source.producer && use.slot === source.slot))
                        known.uses!.push({ producer: source.producer, slot: source.slot });
                }
                else
                    into.set(key, { external: source.external, sha256: source.sha256, at: [composition.record], uses: [{ producer: source.producer, slot: source.slot }] });
            }
            if (additional)
                continue;
            unplacedEntries += composition.body.counts.unplaced;
            if (impact && composition.body.counts.unplaced > 0) {
                const placed = new Set<string>();
                for await (const row of composition.rows(new Set(['case'])))
                    placed.add(row.entry);
                const cases = new Set<string>();
                for await (const row of composition.unplacedRows('case'))
                    if (!placed.has(row.entry))
                        cases.add(row.entry);
                unplacedCases.push(cases.size);
            }
            else
                unplacedCases.push(0);
            const production = await productionOf(context, composition);
            const skipped = production?.detail.problem_chunks ? await readProblemRows(context, production.detail.problem_chunks.skipped) : composition.body.skipped ?? [];
            for (const row of skipped) {
                const parsed = ReasonSchema.safeParse(row.reason_code), reason = parsed.success ? parsed.data : ReasonSchema.parse('awaiting_step');
                const explanation = parsed.success ? `生产时缺少可入根的资料（${labelOf('reason', reason)}）` : `旧生产行的原因码不在当前词表：${JSON.stringify(row.reason_code ?? null)}；缺少可核验的单份原因`;
                candidates.set(`${row.external}\0${composition.record}`, { external: row.external, at: [composition.record], producer: row.producer, slot: row.slot, reason, explanation, ...(production ? { observation: `rec:${production.record.digest}` } : {}), next_action: parsed.success ? '下轮同步自动重试；管理员可按生产动作恢复共享读取条件或修正资料/生产器' : '下轮同步自动重试并重新生产这份来源，以取得当前词表内的单份原因；管理员核对生产器后重读范围' });
            }
            if ((composition.body.skipped_count ?? 0) > skipped.length && production) {
                // Legacy bounded summaries: the original listed ids minus actually used sources identify every missing member.
                const used = new Set((await composition.sources()).map(source => source.external));
                for (const list of production.detail.lists) {
                    const bytes = await context.records.objects.get(list.externals);
                    if (!bytes || sha256Hex(bytes) !== list.externals)
                        throw new KnowledgeError('缺少旧生产动作的完整来源清单；恢复清单后重读范围');
                    const ids: unknown = JSON.parse(Buffer.from(bytes).toString());
                    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
                        throw new KnowledgeError('旧生产动作的来源清单不符合结构；修复后重读范围');
                    for (const id of ids)
                        if (!used.has(id) && !candidates.has(`${id}\0${composition.record}`))
                            candidates.set(`${id}\0${composition.record}`, { external: id, at: [composition.record], producer: list.producer, slot: list.slot, reason: 'awaiting_step', explanation: '旧动作未保留单份原因，未进入这个根', observation: `rec:${production.record.digest}`, next_action: '下轮同步重读完整列表取得单份原因' });
                }
            }
            for (const source of production?.detail.missing ?? [])
                optional.push({ at: [composition.record], external: source.external, producer: source.producer, slot: source.slot, reason: 'missing_input', explanation: source.conclusion ?? (source.external === null ? '构建未声明这个可选来源角色' : '可选来源在本次生产中没有可用观察'), observation: `rec:${production!.record.digest}`, next_action: '来源恢复或构建列表修正后重新同步' });
        }
    const ownIds = new Set([...listed.values()].map(row => row.external)), otherIds = new Set([...other.values()].map(row => row.external));
    const missing = [...candidates.values()].filter(row => !ownIds.has(row.external));
    const elsewhere = missing.flatMap(row => [...other.values()].filter(source => source.external === row.external).map(source => ({ ...row, sha256: source.sha256, at: source.at })));
    const uncovered = missing.filter(row => !otherIds.has(row.external));
    const declared = context.additionalScopeRootsDeclared ?? (context.additionalScopeRoots !== undefined);
    const sort = (rows: ScopedDocument[]) => rows.sort((a, b) => compareText(a.external ?? '', b.external ?? '') || compareText(a.sha256 ?? '', b.sha256 ?? ''));
    for (const doc of [...listed.values(), ...other.values()]) {
        doc.at?.sort(compareText);
        doc.uses?.sort((a, b) => compareText(a.producer, b.producer) || compareText(a.slot, b.slot));
    }
    return { not_in_roots: sort([...candidates.values()]), roots: allMain.map(header), additional_roots: extra.map(header), additional_roots_declared: declared, listed: sort([...listed.values()]), elsewhere: sort(elsewhere), omitted: declared || uncovered.length === 0 ? sort(uncovered) : null, pending: declared ? [] : sort(uncovered), optional: sort(optional), unplaced_entries: unplacedEntries, ...(impact ? { unplaced_cases: { from: unplacedCases[0] ?? 0, to: unplacedCases[1] ?? unplacedCases[0] ?? 0 } } : {}) };
}
