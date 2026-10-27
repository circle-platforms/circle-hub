// Structural obligations and declaration equality only. Core quote@1 separately verifies every original fragment.
import T from '../tables/recompose-format.json' with { type: 'json' };
import { canonicalJson } from './canonical-json.ts';
import { authorityOf, reviewedAtom, acceptedPair, object } from './recompose-evidence.ts';
import { compileGrammar, commandIdentity, parseCommandState, type CommandDefinition } from './generated/command-grammar.ts';
import type { AuthorAtom } from './compile-structure.ts';
import SHAPE from '../tables/recompose-record.schema.json' with { type: 'json' };
import { schema } from './schema.ts';
import CODES from '../tables/recompose-codes.json' with { type: 'json' };
const text = (v: any) => typeof v === 'string' && v.length > 0;
const exitOk = (v: any) => object(v) && ['action', 'object', 'owner', 'due'].every(k => text(v[k]));
const unknownOk = (v: any) => object(v) && ['missing', 'next_action', 'audience', 'due'].every(k => text(v[k]));
export function recomposeOut(verdict: string, statement: string, extra: any = {}) { return { verdict, statement, grounds: [], tier: 'blocking', ...extra }; }
export function checkRecomposition(input: any): any[] {
    const s = input.subject ?? {}, fields = s.fields ?? {}, record = s.data, ctx = s.context ?? {}, atoms: AuthorAtom[] = fields.atoms ?? [], out: any[] = [];
    const unknown = (missing: string, owner = '重组模型与产品包作者', at = '/record') => { const full = missing + '；等待' + owner + '在重新提交之前补事实并重产'; out.push(recomposeOut('unknown', full, { reason: 'missing_input', missing: full, pointer: at, data: { missing_fact: missing, next_action: '补事实并重产', owner, due: '重新提交之前' } })); };
    const bad = (key: string, why: string, at: any = '/record', data: any = {}) => { if (typeof at !== 'string') {
        data = { ...at, ...data };
        at = '/record';
    } const row = CODES.violations.find(r => r.code === 'recompose.' + key); out.push(recomposeOut('refute', why + '；' + (row?.fix ?? '重组者按声明形状修正后重交'), { ...(row ? { code: row.code } : {}), pointer: at, ...(data.conditional_on_judgment ? { judgment_sources: ['/record/0'] } : {}), data: { ...data, missing_fact: why, next_action: row?.fix ?? '重组者修正后重交', owner: '重组者/产品包作者', due: '重新提交之前' } })); };
    if (!object(record)) {
        unknown('缺独立 recompose-record@1 产物', '重组模型');
        return out;
    }
    const physical = (v: any): boolean => Array.isArray(v) ? v.some(physical) : object(v) ? Object.entries(v).some(([k, x]) => T.bed_fields.includes(k) || physical(x)) : false;
    if (physical(record) || record.ledgers?.rebindings?.length)
        bad('bound_to_bed', '重组账本出现物理目标字段或重绑定项');
    for (const c of Array.isArray(record.sources?.candidates) ? record.sources.candidates : [])
        if (c.signing_authority !== false)
            bad('candidate_signed', '候选没有签发权，必须显式 false');
    if (!schema(SHAPE).safeParse(record).success) {
        bad('', '重组产物不符合声明的完整形状');
        return out;
    }
    for (const u of record.unknowns ?? [])
        if (unknownOk(u))
            unknown(u.missing + '；' + u.next_action, u.audience);
        else
            bad('missing_without_exit', '未知条目缺 missing/next_action/audience/due');
    if (record.schema !== T.record || record.case?.source_ref !== fields.source_ref || record.case?.node !== fields.node || record.case?.id !== fields.case_id)
        bad('quote_not_verbatim', '产物没有绑定实际作者用例身份');
    if (fields.missing?.length)
        unknown(fields.missing.join('；'), '作者');
    if (!atoms.length)
        unknown('缺由结构投影计算的作者原子全集', '作者');
    const ids = atoms.map(a => a.id), declared = Array.isArray(record.atoms) ? record.atoms : [];
    const key = (values: any) => Array.isArray(values) ? [...values].sort() : [];
    if (canonicalJson(key(declared.map((a: any) => a.id))) !== canonicalJson(key(ids)))
        bad('atom_dropped', '作者原子全集不等于结构投影', {}, { expected: ids });
    if (record.ledgers?.original?.length !== atoms.length || record.ledgers.original.some((o: any) => !ids.includes(o.atom)))
        bad('quote_not_verbatim', '原文账含重复或作者全集之外的原子');
    for (const atom of atoms) {
        const row = declared.find((a: any) => a.id === atom.id), original = record.ledgers?.original?.filter((a: any) => a.atom === atom.id) ?? [];
        if (!row || row.text !== atom.text || row.quote_ref !== atom.reference || canonicalJson(row.span) !== canonicalJson([atom.start, atom.end]) || original.length !== 1 || original[0].text !== atom.text || original[0].quote_ref !== atom.reference)
            bad('quote_not_verbatim', '原文账必须逐字等于投影的原子及位置');
    }
    for (const [name, kind] of [['intent', 'action'], ['expectation', 'expectation']]) {
        const v = record.contract?.[name];
        if (!object(v) || v.verbatim !== true || !atoms.some(a => (a.kind === kind || name === 'intent' && a.kind === 'intent') && a.text === v.text && a.reference === v.quote_ref))
            bad('quote_not_verbatim', name + ' 不等于原件中声明位置的逐字原子');
    }
    const method = record.contract?.method;
    if (!object(method) || !T.method_kinds.includes(method.kind))
        bad('', '验证方法种类不在三值声明中');
    else if (method.kind === 'missing') {
        if (!record.unknowns?.some(unknownOk))
            bad('missing_without_exit', '方法真实欠缺而没有具名出口');
        else
            unknown('缺验证方法：' + record.unknowns.map((u: any) => u.missing).join('；'));
    }
    else if (!text(method.text) || !Array.isArray(method.sources) || !method.sources.length || !text(method.basis))
        unknown('缺方法来源和具名声明位置', '重组模型');
    if (!object(record.ledgers) || !['original', 'adapted', 'concretizations', 'rebindings'].every(k => Array.isArray(record.ledgers[k])))
        bad('atom_dropped', '必须分开保留四本账');
    const coverage = record.coverage ?? {}, mapped = object(coverage.mapped) ? coverage.mapped : {}, unmapped = Array.isArray(coverage.unmapped) ? coverage.unmapped : [], slots = Array.isArray(record.expectation_slots) ? record.expectation_slots : [];
    if (canonicalJson(key(coverage.author_atoms)) !== canonicalJson(key(ids)) || canonicalJson(key([...Object.keys(mapped), ...unmapped])) !== canonicalJson(key(ids)) || new Set([...Object.keys(mapped), ...unmapped]).size !== ids.length)
        bad('atom_dropped', '覆盖分母和分子必须逐项对应实际作者原子，不能自报覆盖率');
    const slotIds = slots.map((v: any) => v.slot);
    if (new Set(slotIds).size !== slotIds.length)
        bad('atom_dropped', '期望位身份重复');
    for (const [id, targets] of Object.entries(mapped))
        if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length || targets.some(t => !slotIds.includes(t)))
            bad('atom_dropped', '原子 ' + id + ' 没有实际期望位映射');
    if (unmapped.length && record.status === 'complete')
        bad('atom_dropped', '存在未映射原子，不能自报 complete');
    for (const id of unmapped) {
        if (!(record.unknowns ?? []).some((u: any) => unknownOk(u) && (u.atom === id || u.atom === undefined)))
            bad('missing_without_exit', '未映射原子 ' + id + ' 缺具名出口');
        else
            unknown('作者原子 ' + id + ' 尚未映射', '重组模型');
    }
    for (const atom of atoms.filter(a => a.kind === 'expectation'))
        if (!slots.some((v: any) => v.atom === atom.id))
            bad('atom_dropped', '作者期望 ' + atom.id + ' 没有对应期望位');
    for (const slot of slots) {
        if (!T.knowledge_locations.includes(slot.knowledge_location))
            bad('', '期望知识位置不在三值闭集');
        if (slot.knowledge_location === 'recomposable_from_elsewhere' && !slot.evidence?.length)
            unknown('期望位 ' + slot.slot + ' 缺可重组来源', '产品包作者');
        if (slot.knowledge_location === 'genuinely_missing') {
            if (!slot.proposal && !record.unknowns?.some(unknownOk))
                bad('missing_without_exit', '真实欠缺没有提议或出口');
            else
                unknown('期望位 ' + slot.slot + ' 的验证知识真实欠缺', '产品包作者');
        }
    }
    if (ctx.predecessor === undefined)
        unknown('缺 Hub 实际前驱上下文，不能补造历史前驱', '平台维护者');
    else if (ctx.predecessor !== null) {
        const prior = acceptedPair(s.previous_run, s.previous_result, T.packs.stage);
        if (record.predecessor !== ctx.predecessor || !prior || prior.run.run !== ctx.predecessor || !prior.run.items?.some((i: any) => i.fields?.case_id === fields.case_id && i.fields?.source_ref === fields.source_ref))
            bad('atom_dropped', '后一版必须以同一来源用例的实际重组运行为前驱，不能改旧记录或冒接别案');
    }
    else if (record.predecessor !== undefined)
        bad('atom_dropped', '新系列没有实际前驱，不能自填旧记录');
    const authority = authorityOf(s.authority_run, s.authority_result, ctx);
    if (!authority)
        unknown('缺与锁定产品包、版本、根一致的规范来源凭证', '产品包发布管理员');
    const gov = record.sources?.governing ?? [], candidates = record.sources?.candidates ?? [];
    if (authority)
        for (const g of gov)
            if (!authority.governing.some((d: any) => d.ref === g.ref && d.version === g.version && d.kind === g.kind))
                bad('candidate_signed', '签发来源不在产品包本版本声明中');
    const govRefs = gov.map((g: any) => g.ref), candidateRefs = candidates.map((c: any) => c.ref);
    for (const used of [...method?.sources ?? [], ...slots.flatMap((v: any) => v.evidence ?? [])])
        if (!govRefs.includes(used) && !atoms.some(a => a.reference === used) && !(authority?.declarations.some((d: any) => d.role === 'verification_method' && d.ref === used))) {
            if (candidateRefs.includes(used) || authority)
                bad('candidate_signed', '候选或未声明来源被当作方法/期望的签发依据');
            else
                unknown('缺方法来源的产品声明凭证', '产品包作者');
        }
    const usedRefs = [...method?.sources ?? [], ...slots.flatMap((v: any) => v.evidence ?? []), ...govRefs, ...candidateRefs, ...record.ledgers.adapted.flatMap((a: any) => a.equivalence_refs ?? []), ...record.ledgers.concretizations.flatMap((c: any) => [c.value_ref, c.authority].filter(Boolean))];
    for (const ref of new Set(usedRefs))
        if (!atoms.some(a => a.reference === ref) && !(s.evidence ?? []).some((e: any) => e.reference === ref && e.resolved === true && typeof e.text === 'string'))
            unknown('缺可解析且本轮可读的声明片段 ' + ref, '来源维护者');
    const states = record.sources?.states ?? [];
    if (states.length !== ids.length || states.some((v: any) => !ids.includes(v.atom)))
        bad('atom_dropped', '来源状态必须与作者原子全集一一对应');
    const reviews: any[] = [], sourceRun = ctx.predecessor ?? ctx.run ?? null;
    for (const atom of atoms) {
        const rows = states.filter((v: any) => v.atom === atom.id);
        if (rows.length !== 1 || !T.states.includes(rows[0]?.state)) {
            bad('atom_dropped', '每个原子必须有唯一来源状态');
            continue;
        }
        const state = rows[0], review = reviewedAtom(record, atom.id, s.review_run, s.review_result, sourceRun, ctx);
        if (state.state === 'conflict' && (state.prerequisites?.length || review?.state === 'missing_prerequisite'))
            bad('prerequisite_as_conflict', '缺前置不能记成冲突');
        if (!exitOk(state.exit))
            bad('missing_without_exit', '来源状态缺完整 action/object/owner/due 出口');
        if (state.state === 'settled') {
            if (!review || review.state !== 'settled' || state.adjudicated_by !== review.reference)
                unknown('原子 ' + atom.id + ' 缺适用于本提案的已受理独立裁定', '独立裁定模型');
            else
                reviews.push(review);
        }
        else if (state.state === 'conflict') {
            const refs = state.conflicts ?? [];
            if (new Set(refs).size < 2 || refs.some((ref: string) => !govRefs.includes(ref)))
                bad('candidate_signed', '冲突双方必须都有本版本签发权，不能用候选制造冲突');
            else if (authority) {
                const declarations = refs.map((ref: string) => authority.governing.find((g: any) => g.ref === ref)?.constraints?.find((d: any) => d.field === state.conflict_field));
                if (!review || review.state !== 'conflict' || declarations.some((d: any) => !d))
                    unknown('缺冲突适用性独立裁定或具名闭集声明', '独立裁定模型与产品包作者');
                else if (canonicalJson(declarations[0]) === canonicalJson(declarations[1]))
                    bad('', '声称冲突的两个闭集声明完全相等，不能制造冲突');
                else
                    bad('', '两份规范来源的适用性冲突，不能由本模型择一', '/record', { status: 'refused', exit: state.exit, conditional_on_judgment: true, adjudication: review.reference, reviewer: review.reviewer, model: review.model });
            }
            else
                unknown('冲突来源的实际签发权尚未核对', '产品包作者');
        }
        else
            unknown('原子 ' + atom.id + ' 状态 ' + state.state + '：' + (state.reason ?? '缺来源事实') + '；' + (state.exit?.action ?? '补声明'), state.exit?.owner ?? '产品包作者');
    }
    const fromBed = (ref: any) => typeof ref === 'string' && (s.bed_sources ?? []).some((base: string) => ref === base || ref.startsWith(base + '/'));
    for (const row of [...record.ledgers.adapted, ...record.ledgers.concretizations])
        if ([row.source_of_value, row.authority, row.value_ref].some(fromBed))
            bad('bound_to_bed', '重组取值引用了本轮已解析的物理台架来源');
    const raw = s.catalog ?? {}, entries = Array.isArray(raw.entries) ? raw.entries : [], definitions: CommandDefinition[] = entries.filter((e: any) => Array.isArray(e.words) && Array.isArray(e.signatures)).map((e: any) => ({ path: '/commands/' + e.words.map(encodeURIComponent).join('/'), words: e.words, signatures: e.signatures })), grammar = compileGrammar(definitions), identity = (line: string) => commandIdentity(grammar, line);
    for (const atom of atoms) {
        const state = parseCommandState(grammar, atom.content);
        if (state.status === 'parameters_unchecked')
            unknown(state.missing ?? '作者命令的类型未核对', '命令树维护者');
    }
    if (raw.complete === false || raw.missing)
        unknown(raw.missing ?? '锁定目录范围未完整', '产品包作者');
    const sourceCommands = atoms.filter(a => a.kind !== 'intent').flatMap(a => { const id = identity(a.content); return id ? [{ atom: a.id, identity: id }] : []; });
    const actualCommands: any[] = sourceCommands.filter(c => !record.ledgers.adapted.some((a: any) => a.atom === c.atom));
    for (const adapted of record.ledgers?.adapted ?? []) {
        const atom = atoms.find(a => a.id === adapted.atom);
        if (!atom) {
            bad('atom_dropped', '适配项没有一一对应作者原子');
            continue;
        }
        if (!T.actions.includes(adapted.action))
            bad('', '适配动作不在声明闭集中');
        if (!text(adapted.source_of_value) || !text(adapted.authority))
            unknown('适配 ' + adapted.atom + ' 缺 source_of_value/authority', '重组模型');
        else if (authority) {
            if (!govRefs.includes(adapted.authority) && !authority.declarations.some((d: any) => d.ref === adapted.authority))
                unknown('适配 ' + adapted.atom + ' 缺产品授予的 authority', '产品包作者');
            if (!atoms.some(a => a.reference === adapted.source_of_value) && !govRefs.includes(adapted.source_of_value) && !authority.declarations.some((d: any) => d.ref === adapted.source_of_value))
                unknown('适配 ' + adapted.atom + ' 缺合法 source_of_value', '产品包作者');
        }
        if (!adapted.equivalence_refs?.length || authority && !adapted.equivalence_refs.every((ref: string) => authority.declarations.some((d: any) => d.ref === ref)))
            unknown('适配 ' + adapted.atom + ' 缺产品声明位置的等价依据', '产品包作者');
        let critical = adapted.changes?.some((c: any) => T.critical_roles.includes(c.role)) === true;
        const before = sourceCommands.find(c => c.atom === adapted.atom)?.identity;
        for (const line of adapted.commands ?? []) {
            const id = identity(line);
            if (!id) {
                unknown('适配命令没有锁定目录的完整语法身份', '产品包作者');
                continue;
            }
            actualCommands.push({ atom: adapted.atom, identity: id });
            if (before && authority) {
                for (const p of id.parameters) {
                    const old = before.parameters.find(v => v.position === p.position);
                    if (old && canonicalJson(old.parsed) !== canonicalJson(p.parsed) && authority.parameters.some((d: any) => d.path === id.path && d.position === p.position && d.load_bearing === true))
                        critical = true;
                    if (old && canonicalJson(old.parsed) !== canonicalJson(p.parsed) && !record.ledgers.concretizations.some((c: any) => c.atom === adapted.atom && canonicalJson(c.value) === canonicalJson((p.parsed as any).value)))
                        unknown('适配 ' + adapted.atom + ' 的新参数值缺具体化账与来源', '重组模型与产品包作者');
                }
            }
        }
        const review = reviews.find(r => r.atom === adapted.atom);
        if (review?.load_bearing === true)
            critical = true;
        if (critical && adapted.load_bearing !== true)
            bad('unmarked_load_bearing', '产品声明或独立裁定认定承载语义，但适配未标注');
        if (adapted.load_bearing === true && (!Array.isArray(adapted.conditions) || !adapted.conditions.length || adapted.conditions.some((v: any) => !text(v))))
            bad('unmarked_load_bearing', '承载语义适配缺等价条件');
        if (review?.bed_independent === false)
            bad('bound_to_bed', '独立裁定认定本适配依赖具体床', '/record', { conditional_on_judgment: true, adjudication: review.reference, reviewer: review.reviewer, model: review.model });
    }
    if (!raw.root)
        unknown('缺锁定命令目录', '产品包作者');
    const counts = new Map<string, {
        count: number;
        planned: number;
    }>();
    for (const { identity: id } of sourceCommands) {
        const k = canonicalJson([id.tree_root, id.path, id.signature]), row = counts.get(k) ?? { count: 0, planned: 0 };
        row.count++;
        counts.set(k, row);
    }
    for (const { identity: id } of actualCommands) {
        const row = counts.get(canonicalJson([id.tree_root, id.path, id.signature]));
        if (row)
            row.planned++;
    }
    for (const [id, row] of counts)
        if (row.planned < row.count)
            bad('atom_dropped', '可以改参数，不可以删命令', {}, { identity: id, required_count: row.count, planned_count: row.planned, missing_count: row.count - row.planned });
    for (const row of record.ledgers?.concretizations ?? []) {
        if (!text(row.source_of_value) || !text(row.authority)) {
            unknown('具体化 ' + row.slot + ' 缺 source_of_value/authority', '重组模型');
            continue;
        }
        if (!authority) {
            continue;
        }
        const declaration = authority.values.find((d: any) => d.slot === row.slot && d.ref === row.authority);
        if (!declaration) {
            unknown('具体化 ' + row.slot + ' 超出产品取值用途声明', '产品包作者');
            continue;
        }
        if (!T.value_origins.includes(row.source_kind) || !atoms.some(a => a.reference === row.source_of_value) && !govRefs.includes(row.source_of_value) && !authority.declarations.some((d: any) => d.ref === row.source_of_value) && !authority.values.some((d: any) => d.ref === row.source_of_value)) {
            unknown('具体化 ' + row.slot + ' 缺合法取值来源', '产品包作者');
            continue;
        }
        const valueEvidence = (s.evidence ?? []).find((e: any) => e.reference === row.value_ref && e.resolved === true), author = sourceCommands.find(c => atoms.some(a => a.id === c.atom && a.reference === row.source_of_value));
        const fromAuthor = author && row.value_ref === row.source_of_value && declaration.path === author.identity.path && author.identity.parameters.some(p => p.position === declaration.position && canonicalJson((p.parsed as any).value) === canonicalJson(row.value));
        const literal = valueEvidence && valueEvidence.text === String(row.value) && (row.value_ref === row.source_of_value || row.value_ref.startsWith(row.source_of_value + '/'));
        if (!fromAuthor && !literal) {
            unknown('具体化 ' + row.slot + ' 缺与实际来源相等的值或原生参数绑定', '产品包作者');
            continue;
        }
        if (!Array.isArray(declaration.values)) {
            unknown('具体化 ' + row.slot + ' 缺可核的取值闭集或原生参数绑定', '产品包作者');
            continue;
        }
        if (!declaration.values.some((v: any) => canonicalJson(v) === canonicalJson(row.value)))
            unknown('具体化 ' + row.slot + ' 的值不在声明闭集中', '产品包作者');
    }
    if (out.length) {
        const status = out.some(o => o.verdict === 'refute') ? 'refused' : 'partial';
        for (const o of out)
            o.data = { ...o.data, status };
        return out;
    }
    if (record.status !== 'complete')
        return [recomposeOut('refute', '实际覆盖、来源与四账均完整，状态应为 complete；重组者重新提交前修正状态', { data: { status: 'complete' } })];
    return [recomposeOut('support', '重组结构、原文全集、来源凭证、四账和独立裁定已核对；以判断为前提', { data: { schema: T.record, status: 'complete', coverage: { total: ids.length, mapped: ids.length, unmapped: [] }, reviews }, judgment_sources: ['/record/0'] })];
}
