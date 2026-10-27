// Synthetic B6 templates become resolvable fixtures; static adjudication data remains a template, never a Hub receipt.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const text = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8'), json = (p: string) => JSON.parse(text(p)), sha = (v: string) => createHash('sha256').update(v).digest('hex');
export function buildFixtures() {
    const files: Record<string, string> = {}, put = (name: string, value: any) => { const bytes = JSON.stringify(value, null, 2) + '\n'; files[name] = bytes; return 'src:' + sha(bytes); };
    const candidateRef = put('candidate.json', { schema: 'candidate-note@1', text: '合成检索候选，永远没有签发权' });
    const templates = ['pass', 'underdetermined', 'conflict', 'missing-prerequisite'].map(name => ({ name, record: json('templates/recompose-' + name + '.json') }));
    const gov = json('templates/governing-spec.json');
    gov.declared_values = { field: 'orbit.mode', values: ['rr', 'lc', 'hash'] };
    const govRef = put('governing-spec.json', gov);
    const conflict = json('templates/conflicting-spec.json');
    conflict.declared_values = { field: 'orbit.mode', values: ['rr', 'lc', 'hash', 'weighted'] };
    const conflictRef = put('conflicting-spec.json', conflict);
    const declarations = { schema: 'recompose-declarations@1', parameters: [{ path: '/commands/widget/health/interval', position: 1, type: 'int', minimum: 1, maximum: 60, role: 'asserted_value', load_bearing: true }], values: [{ slot: 'interval_value', values: [5] }] };
    const declarationRef = put('declarations.json', declarations), paramRef = declarationRef + '/json@1/p/parameters/0';
    const policy = { adjudication_owner: '产品包作者与集成者', schema: 'recompose-product@1', governing: [{ kind: 'spec', ref: govRef, version: '1.0', authority: 'product-declared', applies_to: { lines: ['10.8'], all_builds: true }, constraints: [gov.declared_values] }, { kind: 'spec', ref: conflictRef, version: '1.1', authority: 'product-declared', applies_to: { lines: ['10.8'], all_builds: true }, constraints: [conflict.declared_values] }], declarations: [{ ref: paramRef, role: 'parameter_type', path: '/commands/widget/health/interval' }], parameters: declarations.parameters, values: [{ slot: 'interval_value', ref: declarationRef + '/json@1/p/values/0', values: [5], path: '/commands/widget/health/interval', position: 1 }] };
    put('product-policy.json', policy);
    for (const [index, { name, record: r }] of templates.entries()) {
        const old = json(name === 'underdetermined' ? '../mindmaps/tiny.km.json' : '../mindmaps/review-150.km.json');
        let selected: any = null;
        const visit = (n: any) => { if (!selected && n.data?.text === r.contract.intent.text && n.children?.some((c: any) => c.data?.text === r.contract.expectation.text))
            selected = structuredClone(n); for (const c of n.children ?? [])
            visit(c); };
        visit(old.root);
        if (!selected)
            throw new Error('synthetic author span absent: ' + name);
        selected.data = { ...selected.data, id: 'case-' + (index + 1), autoid: r.case.id, auto: 'YES', compile_layout: 'case_body_expectations' };
        selected.children = [selected.children.find((c: any) => c.data.text === r.contract.expectation.text)];
        selected.children[0].data.id = 'expected-' + (index + 1);
        const document = { root: { data: { id: 'synthetic-root', text: 'ORBIT / COMET synthetic recomposition' }, children: [selected] }, template: 'right', theme: 'classic', version: '1.4.43' }, sourceRef = put('author-' + name + '.km.json', document), actionRef = sourceRef + '/kityminder@1/n/' + selected.data.id, expectRef = sourceRef + '/kityminder@1/n/' + selected.children[0].data.id;
        r.case = { id: r.case.id, source_ref: sourceRef, source_path: 'tests/fixtures/recompose/author-' + name + '.km.json', node: 'n/' + selected.data.id };
        r.contract.intent.quote_ref = actionRef;
        r.contract.expectation.quote_ref = expectRef;
        r.contract.method.sources = r.contract.method.kind === 'missing' ? [] : [expectRef];
        r.atoms = [{ id: 'a1', kind: 'action', text: r.contract.intent.text, quote_ref: actionRef, span: [0, r.contract.intent.text.length] }, { id: 'a2', kind: 'expectation', text: r.contract.expectation.text, quote_ref: expectRef, span: [0, r.contract.expectation.text.length] }];
        r.ledgers.original = r.atoms.map((a: any) => ({ atom: a.id, text: a.text, quote_ref: a.quote_ref, span: a.span }));
        for (const slot of r.expectation_slots) {
            slot.atom = 'a2';
            slot.evidence = slot.knowledge_location === 'genuinely_missing' ? [] : [expectRef];
        }
        for (const c of r.sources.candidates ?? [])
            c.ref = candidateRef;
        r.sources.governing = [{ kind: 'spec', ref: govRef, version: '1.0', authority: 'product-declared' }, ...(name === 'conflict' ? [{ kind: 'spec', ref: conflictRef, version: '1.1', authority: 'product-declared' }] : [])];
        for (const atom of r.atoms)
            if (!r.sources.states.some((s: any) => s.atom === atom.id))
                r.sources.states.unshift({ atom: atom.id, state: 'settled', adjudicated_by: null, reason: '原始动作存在，等待实际独立裁定凭证', exit: null });
        for (const state of r.sources.states) {
            if (state.state === 'settled') {
                state.adjudicated_by = null;
                state.exit = { action: '交编写阶段消费已受理重组记录', object: state.atom, owner: '编写模型', due: '编写提交之前' };
            }
            if (state.state === 'conflict') {
                state.conflicts = [govRef, conflictRef];
                state.conflict_field = 'orbit.mode';
                state.exit.owner = policy.adjudication_owner;
            }
            if (state.state === 'missing_prerequisite')
                state.prerequisites = [actionRef];
        }
        r.ledgers.adapted = r.ledgers.adapted.map((a: any) => ({ ...a, action: 'parameter_change', text: r.contract.intent.text, commands: [r.contract.intent.text], equivalence_refs: [paramRef], source_of_value: actionRef, authority: paramRef }));
        put('recompose-' + name + '.json', r);
    }
    put('bed-b.json', json('templates/bed-b.json'));
    put('adjudication.json', { ...json('templates/adjudication.json'), is_receipt: false, note: '仅为合成模型裁定模板；测试必须经真实 Hub 工作运行取得快照和已受理结果，不信自述' });
    put('manifest.json', { schema: 'twin-dataset@1', naming: 'ORBIT/COMET and lumen-api; documentation addresses only', files: Object.keys(files).map(name => ({ name, sha256: sha(files[name]) })), templates: 'B6 originals preserved apart from machine paths', runtime_bindings: 'Actual Hub run and validation record references are bound by the synthetic harness; static files never self-attest admission' });
    return files;
}
if (import.meta.main)
    for (const [name, bytes] of Object.entries(buildFixtures()))
        writeFileSync(new URL(name, import.meta.url), bytes);
