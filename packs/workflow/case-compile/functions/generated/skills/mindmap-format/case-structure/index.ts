// The module case-structure of mindmap-format: one declared structural reading of a test mind map, for recomposition and
// compilation. A node's role comes from its tree position and declared fields. No prose classification.
import POLICY from './policy.json' with { type: 'json' };
const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
export interface AuthorAtom {
    id: string;
    kind: (typeof POLICY.atom_kinds)[number];
    text: string;
    content: string;
    reference: string;
    selector: string;
    node_id: string | null;
    start: number;
    end: number;
    labels: string[];
    explicit_labels: string[];
    number_label: string | null;
    after: string[];
}
export interface StructureCase {
    id: string;
    autoid: string | null;
    selector: string;
    depth: number;
    layout: string | null;
    eligible: boolean;
    atoms: AuthorAtom[];
    missing: string[];
    excluded: string[];
    node: number;
}
export interface StructureReport {
    schema: string;
    cases: StructureCase[];
    unclassified: Array<{
        selector: string;
        missing: string;
        next_action: string;
    }>;
}
// A platform export writes a key with no value on group nodes: that declares nothing, so it makes no node a case.
const declared = (value: unknown) => value !== undefined && value !== null && value !== '';
const white = (c: string) => c === ' ' || c === '\t' || c === '\r';
const ident = (s: string) => s.length > 0 && [...s].every(c => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_' || c === '-');
function lineStarts(text: string) { const out = [0]; for (let i = 0; i < text.length; i++)
    if (text[i] === '\n')
        out.push(i + 1); return out; }
function numberEnd(text: string, start: number) { let at = start; while (white(text[at] ?? ''))
    at++; const first = at; while (text[at] >= '0' && text[at] <= '9')
    at++; return at > first && POLICY.number_separators.includes(text[at]) ? at + 1 : null; }
function numberLabel(text: string, start: number) { const end = numberEnd(text, start); if (end === null)
    return null; let at = start; while (white(text[at] ?? ''))
    at++; return text.slice(at, end - 1); }
function leadingLabel(text: string, start: number) { let at = start; while (white(text[at] ?? ''))
    at++; if (text[at] !== '[')
    return null; const end = text.indexOf(']', at + 1); return end >= 0 && ident(text.slice(at + 1, end)) ? { label: text.slice(at + 1, end), end: end + 1 } : null; }
function trailingLabels(text: string) { const labels: string[] = []; let end = text.length; while (end && white(text[end - 1]))
    end--; while (end && text[end - 1] === ']') {
    const at = text.lastIndexOf('[', end - 1), label = text.slice(at + 1, end - 1);
    if (at < 0 || !ident(label))
        break;
    labels.unshift(label);
    end = at;
    while (end && white(text[end - 1]))
        end--;
} return { labels, end }; }
export function analyzeStructure(model: unknown, sha: string, depths?: number[]): StructureReport {
    const report: StructureReport = { schema: POLICY.schema, cases: [], unclassified: [] };
    if (!isRecord(model) || !Array.isArray(model.nodes)) {
        report.unclassified.push({ selector: '', missing: '缺完整脑图结构模型', next_action: '作者按已声明格式重新导出完整脑图' });
        return report;
    }
    const nodes = model.nodes as any[], seen = new Set<number>(), active = new Set<number>(), candidates: Array<{
        index: number;
        depth: number;
        parent: number | null;
    }> = [];
    const walk = (index: number, depth: number, parent: number | null) => {
        const n = nodes[index];
        if (!isRecord(n) || active.has(index) || seen.has(index) || depth > POLICY.maximum_depth) {
            report.unclassified.push({ selector: typeof n?.selector === 'string' ? n.selector : '', missing: '节点重复访问、循环或超出声明深度', next_action: '作者修正节点结构后重读' });
            return;
        }
        seen.add(index);
        active.add(index);
        const data = isRecord(n.data) ? n.data : {};
        const candidate = data.compile_role === 'case' || declared(data.autoid) || declared(data.auto) || Array.isArray(data.resource) && data.resource.length > 0 || data.priority === 2 || data.priority === '2';
        if (!candidate && !(Array.isArray(n.children) && n.children.length) && parent === null && (!depths || depths.includes(depth)) && !POLICY.node_roles.includes(String(data.compile_role)))
            report.unclassified.push({ selector: typeof n.selector === 'string' ? n.selector : '', missing: '叶节点缺用例身份或角色声明，不能把它静默当注记', next_action: '作者明确 compile_role 或自动化编号后重读' });
        if (candidate)
            candidates.push({ index, depth, parent });
        for (const child of Array.isArray(n.children) ? n.children : [])
            if (Number.isSafeInteger(child))
                walk(child, depth + 1, candidate ? index : parent);
        active.delete(index);
    };
    if (nodes.length)
        walk(0, 0, null);
    for (const c of candidates) {
        const node = nodes[c.index], data = node.data ?? {}, missing: string[] = [], excluded: string[] = [], selector = typeof node.selector === 'string' ? node.selector : '', autoid = typeof data.autoid === 'string' && data.autoid.length ? data.autoid : typeof data.autoid === 'number' && Number.isSafeInteger(data.autoid) ? String(data.autoid) : null;
        if (!autoid)
            missing.push('缺原始自动化编号；作者补文字 autoid 后重读');
        if (!selector)
            missing.push('缺稳定节点选择器；作者重新导出完整脑图');
        if (Object.hasOwn(data, 'auto') && data.auto !== null && data.auto !== '') {
            if ((POLICY.auto_excluded as unknown[]).includes(data.auto))
                excluded.push('作者显式声明不自动化');
            else if (!(POLICY.auto_allowed as unknown[]).includes(data.auto))
                missing.push('auto 不在声明闭集；作者明确自动化标记后重读');
        }
        if (depths && !depths.includes(c.depth))
            excluded.push('不在本轮声明的用例深度');
        if (c.parent !== null || candidates.some(other => other.parent === c.index))
            missing.push('嵌套用例的编译范围未声明；作者拆开或明确独立用例边界');
        // Roles come from the tree and declared fields, never from the words. A leaf with the declared precondition priority is a
        // state to establish. Of the rest, a node with children is an action and a leaf under it is that action's expectation, at
        // any depth, so a chain of steps reads as its actions in order. A leaf beside a step is an action no expectation follows,
        // as the reference implementation reads it; it is only an expectation when the case has no step at all.
        const leaf = (n: any) => Array.isArray(n?.children) && n.children.length === 0;
        const children = (node.children ?? []).map((index: number) => nodes[index]);
        const preconditions = children.filter((n: any) => leaf(n) && Number(n?.data?.priority) === POLICY.precondition_priority);
        const body = children.filter((n: any) => !preconditions.includes(n));
        const allLeaves = body.length > 0 && body.every(leaf);
        const allSteps = body.length > 0 && body.every((n: any) => Array.isArray(n?.children) && n.children.length > 0 && n.children.every((i: number) => nodes[i]?.children?.length === 0));
        const anyStep = body.some((n: any) => !leaf(n));
        let layout = typeof data.compile_layout === 'string' ? data.compile_layout : allLeaves ? POLICY.layouts[0] : allSteps ? POLICY.layouts[1] : anyStep ? POLICY.layouts[2] : null;
        if (!layout || !POLICY.layouts.includes(layout) || layout === POLICY.layouts[0] && !allLeaves || layout === POLICY.layouts[1] && !allSteps || layout === POLICY.layouts[2] && !anyStep) {
            missing.push(body.length ? '声明的布局与节点结构不符；作者改 compile_layout 或节点后重读' : '用例节点下没有动作或期望；作者在脑图里补节点后重读');
            layout = null;
        }
        const atoms: AuthorAtom[] = [], sourceRef = (sel: string) => `src:${sha}/kityminder@1/${sel}`;
        const take = (n: any, kind: AuthorAtom['kind'], after: AuthorAtom[]) => {
            const text = typeof n.text === 'string' ? n.text : '', sel = typeof n.selector === 'string' ? n.selector : '';
            if (!text.length) {
                missing.push('存在空的用例原句；作者补完整原文');
                return [];
            }
            const starts = lineStarts(text);
            let cuts: number[];
            if (kind === 'intent')
                cuts = [0];
            else if (kind === 'action') {
                const numbered = starts.filter(at => numberEnd(text, at) !== null);
                cuts = numbered.length ? [...new Set([0, ...numbered])] : starts;
            }
            else {
                const labelled = starts.filter(at => leadingLabel(text, at) !== null || numberEnd(text, at) !== null);
                cuts = labelled.length ? [...new Set([0, ...labelled])] : [0];
            }
            const out: AuthorAtom[] = [];
            for (let k = 0; k < cuts.length; k++) {
                const start = cuts[k], end = k + 1 < cuts.length ? cuts[k + 1] : text.length, raw = text.slice(start, end);
                if (!raw.split('').some((c: string) => !white(c) && c !== '\n'))
                    continue;
                let contentStart = start, contentEnd = end;
                const lead = kind === 'action' ? numberEnd(text, start) : kind === 'expectation' ? (leadingLabel(text, start)?.end ?? numberEnd(text, start)) : null;
                if (lead !== null && lead !== undefined)
                    contentStart = lead;
                while (contentStart < contentEnd && white(text[contentStart]))
                    contentStart++;
                while (contentEnd > contentStart && (white(text[contentEnd - 1]) || text[contentEnd - 1] === '\n'))
                    contentEnd--;
                const tail = kind === 'action' ? trailingLabels(text.slice(contentStart, contentEnd)) : null;
                if (tail)
                    contentEnd = contentStart + tail.end;
                const number = numberLabel(text, start), labels = kind === 'intent' ? [] : kind === 'action' ? [...new Set([...(number ? [number] : []), ...tail?.labels ?? []])] : leadingLabel(text, start)?.label ? [leadingLabel(text, start)!.label] : number ? [number] : [];
                const a: AuthorAtom = { id: 'a' + (atoms.length + 1), kind, text: raw, content: text.slice(contentStart, contentEnd), selector: sel, reference: sourceRef(sel), node_id: typeof n.data?.id === 'string' ? n.data.id : null, start, end, labels, explicit_labels: tail?.labels ?? [], number_label: number, after: [] };
                if (kind === 'expectation') {
                    const explicit = typeof n.data?.step_ref === 'string' ? n.data.step_ref : null;
                    let matches = explicit ? after.filter(a => a.labels.includes(explicit) || a.node_id === explicit) : labels.length ? after.filter(a => a.labels.some(label => labels.includes(label))) : after.length === 1 ? after : [];
                    if (!explicit && !matches.length && after.length === 1 && !after[0].explicit_labels.length && (!number || after[0].number_label === number || after[0].number_label === null))
                        matches = after;
                    // Decision 103 (aligned with SyntheticReference): an expectation with no step_ref, label or number under several actions
                    // belongs to them as one step; the authoring model splits it into verbatim clauses and asserts each after the
                    // operation it observes, a judgment the Hub checks by quote. An explicit reference matching none or several stays unbound.
                    const wholeStep = !explicit && !(n.data && Object.hasOwn(n.data, 'step_ref')) && !labels.length && !number && !matches.length && after.length > 1;
                    if (wholeStep)
                        matches = after;
                    if (n.data && Object.hasOwn(n.data, 'step_ref') && typeof n.data.step_ref !== 'string') {
                        matches = [];
                        missing.push('step_ref 必须是声明的文字标识符；作者修正结构字段');
                    }
                    a.after = matches.map(a => a.id);
                    if (matches.length !== 1 && !wholeStep)
                        missing.push('期望 ' + a.id + ' 缺作者动作定位；作者补 step_ref 或方括号定位后重读');
                }
                atoms.push(a);
                out.push(a);
            }
            return out;
        };
        const step = (n: any) => {
            const actions = take(n, 'action', []);
            for (const i of n.children)
                if (leaf(nodes[i]))
                    take(nodes[i], 'expectation', actions);
                else
                    step(nodes[i]);
        };
        if (layout === POLICY.layouts[0]) {
            for (const child of preconditions)
                take(child, 'action', []);
            const actions = take(node, 'action', []);
            for (const child of body)
                take(child, 'expectation', actions);
        }
        else if (layout !== null) {
            take(node, 'intent', []);
            for (const child of children)
                if (leaf(child))
                    take(child, 'action', []);
                else
                    step(child);
        }
        report.cases.push({ id: typeof data.id === 'string' ? data.id : selector, autoid, selector, depth: c.depth, layout, eligible: missing.length === 0 && excluded.length === 0, atoms, missing: [...new Set(missing)], excluded, node: c.index });
    }
    const duplicateIds = new Set(report.cases.filter(c => c.autoid !== null && report.cases.filter(other => other.autoid === c.autoid).length > 1).map(c => c.autoid));
    for (const c of report.cases)
        if (duplicateIds.has(c.autoid)) {
            c.eligible = false;
            c.missing.push('自动化编号在原件里重复；作者修正编号后重读');
        }
    for (const c of report.cases)
        for (const missing of c.missing)
            report.unclassified.push({ selector: c.selector, missing, next_action: '作者按节点报告补声明后重读；编写模型不得静默略过' });
    return report;
}
