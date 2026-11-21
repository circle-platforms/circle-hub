import type {RequirementStatus, Verdict} from '../../../../contracts/generated/vocabulary.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
// Consume an admitted case artifact, not a review receipt or a self-described upload.
import { acceptedPair, acceptsPack, envelope, object } from './recompose-evidence.ts';
import { PLAN_DATA, listed, refusalText, shownValue } from './refusal-form.ts';
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
    return { record, receipt: pair.reference, run: pair.run.run, source, conditional_on_judgment: true, record_sha256: recordSha256(record) };
}
/**
 * The digest a plan names a recomposition record by: sha256 of the record's canonical JSON. A late-bound result changes its receipt
 * whenever another case of the same recompose run is accepted; the record of this case changes only when this case is recomposed again.
 */
export function recordSha256(record: unknown): string {
    return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
/** The late-bound slot a frozen item takes its recomposition from at every evaluation (functions/project.ts writes it into the item). */
export interface LateMarker { slot: string; run: string; source: string; node: string }
/** What a late-bound recomposition still waits for: the result the Hub resolved, if any, and what this case's entry in it shows. */
export type WaitingState = 'no_result' | 'uncovered' | Extract<RequirementStatus, 'unsatisfied' | 'pending'> | 'partial';
export interface RecompositionWaiting { run: string; result: string | null; state: WaitingState; item: string | null; autoid?: string; missing?: string }
/** The latest accepted result of a late-bound recompose run as the Hub resolved it for this evaluation (ItemRefreshInput.late). */
export interface LateResult { run: string; input: unknown; missing?: string }

/**
 * The overlay of one item for this evaluation (ItemRefreshOutput.items[].late): the admitted record with its digest, marked late;
 * or why it is not admitted, and, when the case only waits for its own recomposition to be accepted, what it waits for.
 */
export function lateRecomposition(runInput: any, late: LateResult, context: any, source: string, node: string, autoid?: string): Record<string, unknown> {
    const proof = admittedRecomposition(runInput, late.input, context, source, node);
    if (proof)
        return { recomposition: { ...proof, late: true } };
    const found = diagnose(runInput, late.input, context, source, node, late);
    return {
        recomposition_problem: found.text,
        ...(found.waiting ? { recomposition_waiting: { run: late.run, result: object(late.input) && typeof (late.input as any).meta?.record === 'string' ? 'rec:' + (late.input as any).meta.record : null, state: found.waiting, item: found.item, ...(autoid !== undefined ? { autoid } : {}), ...(late.missing !== undefined ? { missing: late.missing } : {}) } satisfies RecompositionWaiting } : {}),
    };
}
/**
 * Why the bound recomposition was not admitted (called after admittedRecomposition returned null), one of its conditions at a
 * time and in the same order, in words the writer can act on. Without it every one of these collapsed into one sentence that sent
 * a model in run 13 to wait for an "independent reviewer" when it had bound the same result record in both slots.
 */
export function recompositionProblem(runInput: any, resultInput: any, context: any, source: string, node: string, late?: { run: string; missing?: string }): string {
    return diagnose(runInput, resultInput, context, source, node, late).text;
}
/**
 * The first condition admittedRecomposition found unmet, in words, and for a late-bound result whether the case only waits for its own
 * record to be accepted. A frozen binding keeps the order it always had. A late binding checks first what the frozen run record alone
 * decides (the run, its pack, its product and whether it has this case at all: these never change by waiting), then the result.
 */
function diagnose(runInput: any, resultInput: any, context: any, source: string, node: string, late?: { run: string; missing?: string }): { text: string; waiting: WaitingState | null; item: string | null } {
    const problem = (text: string) => ({ text, waiting: null, item: null });
    const run = envelope(runInput, 'run'), result = envelope(resultInput, 'validation_result');
    const kindOf = (bound: any) => object(bound) ? (bound.meta?.kind ?? bound.model?.kind ?? '原件') : '未绑定';
    const named = (bound: any) => object(bound) && typeof bound.meta?.record === 'string' ? `rec:${bound.meta.record.slice(0, 12)}…` : '';
    const same = object(runInput) && object(resultInput) && typeof runInput.meta?.record === 'string' && runInput.meta?.record === resultInput.meta?.record;
    const how = 'recomposition_run 绑重组运行的运行记录（rec:），recomposition_result 绑重组运行号（run_…，Hub 换成该运行已受理的结果）';
    if (!run) return problem(`recomposition_run 绑的是 ${kindOf(runInput)} 记录 ${named(runInput)}，不是重组运行的运行记录${same ? '：两个槽写成了同一个引用' : ''}；${how}`);
    const targetOf = () => run.body.items?.find((i: any) => i.fields?.source_ref === source && i.fields?.node === node);
    if (late) {
        if (run.body.run !== late.run) return problem(`recomposition_run 是重组运行 ${run.body.run} 的运行记录，recomposition_result 绑的却是重组运行 ${late.run}；两个槽写同一个重组运行，用 open-compile 重开计划运行`);
        if (!acceptsPack(run.body.pack, T.packs.stage)) return problem('这份重组后的用例使用的技能版本不受支持；请使用当前技能重新做用例重组');
        if (run.body.product !== context.product || run.body.root !== context.root || run.body.product_pack_digest !== context.product_pack_digest) return problem(`重组运行 ${run.body.run} 的产品、版本根或产品包与本运行不同；按本运行的产品和构建重新重组`);
        if (!targetOf()) return problem(`重组运行 ${run.body.run} 里没有这条用例（脑图节点 ${node}）；用同一份脑图原件重组`);
    }
    const target = targetOf();
    if (!result) {
        if (late && resultInput == null) return { text: `重组运行 ${late.run} 还没有已受理提交${late.missing ? `（Hub 的答复：${late.missing}）` : ''}；等这一条在重组运行 ${late.run} 单条提交并被受理`, waiting: 'no_result', item: target?.id ?? null };
        return problem(`recomposition_result 绑的是 ${kindOf(resultInput)} ${named(resultInput)}，不是重组运行已受理的结果；${how}`);
    }
    if (!acceptsPack(run.body.pack, T.packs.stage)) return problem('这份重组后的用例使用的技能版本不受支持；请使用当前技能重新做用例重组');
    if (result.body.schema !== 'validation@1' || result.body.run !== run.body.run) return problem(`recomposition_result 不是重组运行 ${run.body.run} 的结果（它属于 ${result.body.run}）`);
    if (result.body.acceptance !== 'accepted') return problem(`重组运行 ${run.body.run} 的这份结果没有被受理；按它的回执改正重交，受理后再绑定`);
    if (result.body.locks?.pack !== run.body.pack || result.body.locks?.pack_digest !== run.body.pack_digest) return problem(`重组结果锁定的包和重组运行 ${run.body.run} 的包不一致`);
    if (run.body.product !== context.product || run.body.root !== context.root || run.body.product_pack_digest !== context.product_pack_digest) return problem(`重组运行 ${run.body.run} 的产品、版本根或产品包与本运行不同；按本运行的产品和构建重新重组`);
    if (!target) return problem(`重组运行 ${run.body.run} 里没有这条用例（脑图节点 ${node}）；用同一份脑图原件重组`);
    const row = Object.values(result.body.partitions ?? {}).flatMap((v: any) => Array.isArray(v) ? v : []).find((i: any) => i.item === target.id);
    const status = row?.requirements?.find((r: any) => r.requirement === 'record')?.status;
    if (status !== 'satisfied') {
        if (!late) return problem(`重组运行 ${run.body.run} 里这条用例的 record 要求项没有满足；按重组回执补齐后重交`);
        const state = status === 'unsatisfied' ? 'unsatisfied' : status === 'pending' ? 'pending' : 'uncovered';
        return { text: `重组运行 ${run.body.run} 最近受理的结果 ${result.reference.slice(0, 16)}… 里${state === 'uncovered' ? `没有这一条（条目 ${target.id}）的 record 要求项` : `这一条（条目 ${target.id}）的 record 要求项 status 为 ${state}`}；等这一条在重组运行 ${run.body.run} 单条提交并被受理`, waiting: state, item: target.id };
    }
    const claim = row.requirements.find((r: any) => r.requirement === 'record').claims?.find((c: any) => c.warrant?.producer === 'model' && c.validity?.status === 'valid' && c.statement?.data?.schema === T.record && c.statement.data.case?.source_ref === source && c.statement.data.case?.node === node);
    if (late && claim?.statement.data.status === 'partial') return { text: `重组运行 ${run.body.run} 最近受理的结果 ${result.reference.slice(0, 16)}… 里这一条（条目 ${target.id}）的记录 status 为 partial；等这一条补齐后在重组运行 ${run.body.run} 单条提交并被受理`, waiting: 'partial', item: target.id };
    return problem('重组记录不完整，或它的前驱与重组运行不同；按重组回执补齐后重交');
}

/** Where the plan declares the recomposition it consumes, and where the frozen item of the run discloses the values to declare. */
const DECLARED = PLAN_DATA + '/recomposition';
const DISCLOSED = '/fields/recomposition';
/** Where late.json discloses the values of a late-bound record: the item's overlay (run-late@1 items[].late). */
const LATE_DISCLOSED = '/late/recomposition';

/**
 * What a plan's `recomposition` declaration lacks or gets wrong against the admitted recomposition record `proof` (the item's
 * `fields.recomposition`). Each gap is one condition of the check, as it always was; its text says where it sits, the value seen,
 * the allowed set and the next step, with the values the writer copies and where the frozen item discloses them. `where.item` is
 * the id of the item (the item file the download writes holds it), named so the file is found without opening them all.
 */
export function recompositionGaps(slots: PlanSlots, proof: any, where: { item?: string } = {}): Array<{
    message: string;
    verdict: Extract<Verdict, 'unknown' | 'refute'>;
}> {
    if (!proof)
        return [];
    const issues: Array<{
        message: string;
        verdict: Extract<Verdict, 'unknown' | 'refute'>;
    }> = [], use = slots.recomposition, note = (message: string, verdict: Extract<Verdict, 'unknown' | 'refute'> = 'unknown') => issues.push({ message, verdict });
    const expects = slots.expects.map((e, i) => ({ ...e, identity: e.id ?? String(i + 1), index: i }));
    // What the texts read of the record never throws: a record the check itself cannot read fails where it always failed.
    const slotsRead = (): any[] => proof.record?.expectation_slots ?? [];
    const atomOf = (slot: any) => proof.record?.atoms?.find?.((a: any) => a.id === slot.atom);
    // The assertions that can serve a slot: those the check below accepts for it (the slot's sentence, quoted whole, and its criterion).
    const serving = (slot: any): string[] => { const atom = atomOf(slot); return expects.filter(e => e.quote?.reference === atom?.quote_ref && e.quote?.text === atom?.text && (slot.criterion_id === undefined || e.criterion === slot.criterion_id)).map(e => e.identity); };
    // A late-bound record (proof.late) is named by its own digest: the receipt of the whole result changes whenever another case of the
    // same recompose run is accepted, so it is disclosed and never compared; a frozen binding is compared by its receipt as it always was.
    const late = proof.late === true, digestOf = (): string => typeof proof.record_sha256 === 'string' ? proof.record_sha256 : recordSha256(proof.record);
    const file = late
        ? (where.item === undefined ? '运行目录的 late.json 里本条目的 ' : `运行目录的 late.json 里 items 中 id 为 ${where.item} 的条目的 `)
        : (where.item === undefined ? '冻结条目文件 items/<序号>.json ' : `冻结条目文件 items/<序号>.json（里面的 id 是 ${where.item}）`);
    const at = late ? LATE_DISCLOSED : DISCLOSED;
    const disclosed = late
        ? `${file}${at}（late.json 由 download-run.ts 或 refresh-late.ts 写，是 Hub 这次核对时取的最近受理的重组结果）：record_sha256 在 ${at}/record_sha256，case_id 在 ${at}/record/case/id，期望判断依据在 ${at}/record/expectation_slots，receipt 在 ${at}/receipt（只披露，不核对）`
        : `${file}的 ${DISCLOSED}：receipt 在 ${DISCLOSED}/receipt，case_id 在 ${DISCLOSED}/record/case/id，期望判断依据在 ${DISCLOSED}/record/expectation_slots`;
    const sentence = (slot: any) => { const atom = atomOf(slot); return `reference ${shownValue(atom?.quote_ref)}，text ${shownValue(atom?.text)}`; };
    if (!use) {
        const rows = slotsRead().map(slot => ({ slot: slot.slot, assertions: serving(slot), sentence: sentence(slot) }));
        const declaration = JSON.stringify({ receipt: proof.receipt, ...(late ? { record_sha256: digestOf() } : {}), case_id: proof.record?.case?.id, slots: rows.map(row => ({ slot: row.slot, assertions: row.assertions.length ? row.assertions : ['<断言 id>'] })), rebindings: [] });
        note(refusalText({
            what: '计划没有声明它消费的重组记录（recomposition）',
            place: DECLARED,
            seen: '没有这个字段',
            also: [
                `值都在${disclosed}；编写简报 briefs/<序号>.md 的计划文件外壳里已经填好同样的 recomposition`,
                `各期望判断依据可用的断言 id（引文与它的用例原句相同，平面计划是 expects 从 1 起的序号写成字符串，分块计划是断言自己的 id）：${rows.map(row => row.assertions.length ? `${row.slot} 用 ${listed(row.assertions)}` : `${row.slot} 本计划没有断言引用它的用例原句（${row.sentence}），先写这样的断言`).join('，')}`,
            ],
            next: `在 ${PLAN_DATA} 里加上 "recomposition": ${declaration}`,
        }));
        return issues;
    }
    // In this order, as it always was: a record the check cannot read fails where it always failed (reading its case id).
    const wrongReceipt = !late && use.receipt !== proof.receipt;
    const wrongDigest = late ? use.record_sha256 !== digestOf() : use.record_sha256 !== undefined && use.record_sha256 !== digestOf();
    if (wrongReceipt || wrongDigest || use.case_id !== proof.record.case.id) {
        const wrongCase = use.case_id !== proof.record?.case?.id, digest = wrongDigest ? digestOf() : '';
        const names = [wrongReceipt ? 'receipt' : '', wrongDigest ? 'record_sha256' : '', wrongCase ? 'case_id' : ''].filter(Boolean);
        note(refusalText({
            what: `recomposition 的 ${names.join('、')} 不是本条用例已受理的重组记录的，不能用评审或别的用例的替代`,
            place: [wrongReceipt ? `${DECLARED}/receipt` : '', wrongDigest ? `${DECLARED}/record_sha256` : '', wrongCase ? `${DECLARED}/case_id` : ''].filter(Boolean).join('、'),
            seen: [wrongReceipt ? `receipt ${shownValue(use.receipt)}` : '', wrongDigest ? `record_sha256 ${shownValue(use.record_sha256)}` : '', wrongCase ? `case_id ${shownValue(use.case_id)}` : ''].filter(Boolean).join('，'),
            allowed: [wrongReceipt ? `receipt 只能是 ${shownValue(proof.receipt)}` : '', wrongDigest ? `record_sha256 只能是 ${shownValue(digest)}` : '', wrongCase ? `case_id 只能是 ${shownValue(proof.record?.case?.id)}` : ''].filter(Boolean),
            also: [`这些值披露在${disclosed}`, ...(late && wrongDigest ? ['这一条的重组记录按 record_sha256 核对：同一重组运行里别的用例被受理只换 receipt，不换这个值；这个值变了，说明这一条的重组记录重新被受理过，计划要按新记录核对改写'] : [])],
            next: '照允许的值改写',
        }), 'refute');
        return issues;
    }
    const recordSlots: any[] = proof.record.expectation_slots, slotIds: string[] = recordSlots.map(s => s.slot);
    const assigned = new Map<string, string>();
    for (const [i, row] of use.slots.entries()) {
        if (!recordSlots.some((s: any) => s.slot === row.slot))
            note(refusalText({
                what: '对应关系里有重组记录之外的期望判断依据',
                place: `${DECLARED}/slots/${i}/slot`,
                seen: shownValue(row.slot),
                allowed: slotIds,
                next: '改成允许的期望判断依据，或删去这一行',
            }), 'refute');
        for (const [j, id] of row.assertions.entries()) {
            if (assigned.has(id))
                note(refusalText({
                    what: '不同的期望判断依据不能共用一个断言',
                    place: `${DECLARED}/slots/${i}/assertions/${j}`,
                    seen: `断言 ${shownValue(id)} 已经列在 ${assigned.get(id)} 下，又列在 ${row.slot} 下`,
                    next: `每个断言只列在一个期望判断依据下；${row.slot} 另选断言 id（本计划的断言 id：${listed(expects.map(e => e.identity))}）`,
                }), 'refute');
            else
                assigned.set(id, row.slot);
        }
    }
    for (const slot of recordSlots) {
        const rows = use.slots.filter(r => r.slot === slot.slot);
        if (rows.length !== 1 || !rows[0].assertions.length) {
            const offered = serving(slot);
            note(refusalText({
                what: `重组记录里的期望判断依据 ${slot.slot} 还没有自己的断言`,
                place: `${DECLARED}/slots`,
                seen: rows.length === 1 ? `${slot.slot} 的一行 assertions 是空的` : `${slot.slot} 写了 ${rows.length} 行`,
                allowed: offered,
                also: [`允许的是本计划里引文与 ${slot.slot} 的用例原句相同的断言${offered.length ? '' : `；现在没有这样的断言（${sentence(slot)}）`}`],
                next: `为 ${slot.slot} 写且只写一行 ${JSON.stringify({ slot: slot.slot, assertions: offered.length ? offered : ['<断言 id>'] })}${offered.length ? '' : '，并先在计划里写一条引文是这句原文的断言'}`,
            }));
            continue;
        }
        const atom = proof.record.atoms.find((a: any) => a.id === slot.atom), rowIndex = use.slots.indexOf(rows[0]);
        for (const [j, id] of rows[0].assertions.entries()) {
            const e = expects.find(e => e.identity === id);
            if (!e || e.quote.reference !== atom?.quote_ref || e.quote.text !== atom?.text || slot.criterion_id !== undefined && e.criterion !== slot.criterion_id) {
                const offered = serving(slot);
                if (!e)
                    note(refusalText({
                        what: `期望判断依据 ${slot.slot} 列的断言不在本计划里`,
                        place: `${DECLARED}/slots/${rowIndex}/assertions/${j}`,
                        seen: shownValue(id),
                        allowed: expects.map(x => x.identity),
                        also: offered.length === expects.length ? [] : [offered.length ? `其中引文与 ${slot.slot} 的用例原句相同的是 ${listed(offered)}` : `其中没有引文与 ${slot.slot} 的用例原句相同的（${sentence(slot)}）`],
                        next: '改成允许的断言 id（平面计划是 expects 从 1 起的序号写成字符串，分块计划是断言自己的 id）',
                    }), 'refute');
                else {
                    const differs = [
                        e.quote.reference !== atom?.quote_ref ? `quote.reference 是 ${shownValue(e.quote.reference)}，应是 ${shownValue(atom?.quote_ref)}` : '',
                        e.quote.text !== atom?.text ? `quote.text 是 ${shownValue(e.quote.text)}，应是 ${shownValue(atom?.text)}` : '',
                        slot.criterion_id !== undefined && e.criterion !== slot.criterion_id ? `criterion 是 ${shownValue(e.criterion)}，应是 ${shownValue(slot.criterion_id)}` : '',
                    ].filter(Boolean);
                    note(refusalText({
                        what: `期望判断依据 ${slot.slot} 的断言 ${shownValue(id)} 与它的用例原句对不上`,
                        place: `${PLAN_DATA}${e.origin ?? `/expects/${e.index}`}/quote`,
                        seen: differs.join('，'),
                        next: `把这条断言的引文改成 ${slot.slot} 的用例原句（${sentence(slot)}），或在 recomposition 里为 ${slot.slot} 改列引文已经是它的断言${offered.length ? `：${listed(offered)}` : ''}`,
                    }), 'refute');
                }
            }
        }
    }
    return issues;
}
