// Generate local work-language schemas and isolated stage publication units from explicit declarations.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const base = new URL('../', import.meta.url), read = (p: string) => JSON.parse(readFileSync(new URL(p, base), 'utf8')), write = (p: string, v: unknown) => { mkdirSync(new URL('.', new URL(p, base)), { recursive: true }); writeFileSync(new URL(p, base), JSON.stringify(v, null, 2) + '\n'); };
const T = read('tables/recompose-format.json');
const str = { type: 'string', minLength: 1 }, array = (items: any, minItems = 0) => ({ type: 'array', items, minItems, maxItems: T.max_atoms }), obj = (properties: any, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required }), choice = (values: any[]) => ({ type: 'string', enum: values }), nullable = (v: any) => ({ anyOf: [v, { type: 'null' }] }), span = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0 } }, scalar = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
const exit = obj({ action: { type: 'string' }, object: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' } }, []), unknown = obj({ atom: str, missing: { type: 'string' }, next_action: { type: 'string' }, audience: { type: 'string' }, due: { type: 'string' } }, []);
const gov = obj({ kind: choice(T.governing_kinds), ref: str, path: str, version: str, authority: { const: 'product-declared' } }, ['kind', 'ref', 'version', 'authority']);
const author = obj({ id: str, kind: choice(T.atom_kinds), text: str, quote_ref: str, span, meaning: str }, ['id', 'kind', 'text', 'quote_ref', 'span']);
const original = obj({ atom: str, text: str, quote_ref: str, span }, ['atom', 'text', 'quote_ref']);
const adapted = obj({ atom: str, action: choice(T.actions), text: str, commands: array(str), equivalence_reason: str, equivalence_refs: array(str), load_bearing: { type: 'boolean' }, conditions: array(str), source_of_value: str, authority: str, changes: array(obj({ role: choice(T.critical_roles), from_ref: str, to_ref: str })) }, ['atom', 'action', 'commands', 'equivalence_reason', 'equivalence_refs', 'load_bearing', 'conditions']);
const concrete = obj({ atom: str, slot: str, value: scalar, value_ref: str, source_of_value: str, decided_by: str, source_kind: choice(T.value_origins), authority: str }, ['slot', 'value', 'value_ref', 'decided_by']);
const record = obj({ schema: { const: T.record }, case: obj({ id: str, source_ref: str, source_path: str, node: str }, ['id', 'source_ref', 'node']), contract: obj({ intent: obj({ text: str, quote_ref: str, verbatim: { const: true } }), method: obj({ kind: choice(T.method_kinds), text: nullable({ type: 'string' }), sources: array(str), basis: nullable({ type: 'string' }) }), expectation: obj({ text: str, quote_ref: str, verbatim: { const: true } }) }), expectation_slots: array(obj({ slot: str, atom: str, knowledge_location: choice(T.knowledge_locations), evidence: array(str), proposal: { anyOf: [str, array(str), { type: 'null' }] }, criterion_id: str }, ['slot', 'atom', 'knowledge_location', 'evidence', 'proposal'])), coverage: obj({ author_atoms: array(str), mapped: { type: 'object', additionalProperties: array(str) }, unmapped: array(str) }), atoms: array(author), sources: obj({ governing: array(gov), candidates: array(obj({ ref: str, path: str, found_by: str, signing_authority: { type: 'boolean' } }, ['ref', 'found_by', 'signing_authority'])), states: array(obj({ atom: str, state: choice(T.states), adjudicated_by: nullable(str), reason: str, exit: nullable(exit), conflicts: array(str), prerequisites: array(str), conflict_field: str }, ['atom', 'state', 'adjudicated_by', 'reason', 'exit'])) }), ledgers: obj({ original: array(original), adapted: array(adapted), concretizations: array(concrete), rebindings: array({ type: 'object', additionalProperties: true }) }), status: choice(T.statuses), unknowns: array(unknown), predecessor: str }, ['schema', 'case', 'contract', 'expectation_slots', 'coverage', 'atoms', 'sources', 'ledgers', 'status', 'unknowns']);
write('tables/recompose-record.schema.json', record);
try {
    const slots = read('recompose/slots.schema.json');
    slots.item.record.data = record;
    write('recompose/slots.schema.json', slots);
}
catch { }
write('tables/recompose-sources.schema.json', { ...record.properties.sources, title: T.sources });
write('tables/recompose-sources.schema.json', { ...record.properties.sources, title: T.sources });
const governingProduct = obj({ ...gov.properties, applies_to: obj({ lines: array(str, 1), all_builds: { type: 'boolean' }, builds: array(str) }, ['lines']), constraints: array(obj({ field: str, values: array(scalar) })) }, ['kind', 'ref', 'version', 'authority', 'applies_to']);
write('tables/recompose-product.schema.json', obj({ schema: { const: T.product }, adjudication_owner: str, governing: array(governingProduct), declarations: array(obj({ ref: str, role: choice(T.declaration_roles), path: str }, ['ref', 'role'])), parameters: array(obj({ path: str, position: { type: 'integer', minimum: 0 }, type: str, minimum: { type: 'number' }, maximum: { type: 'number' }, role: str, load_bearing: { type: 'boolean' } }, ['path', 'position', 'role', 'load_bearing'])), values: array(obj({ slot: str, ref: str, values: array(scalar), path: str, position: { type: 'integer', minimum: 0 } }, ['slot', 'ref'])) }));
const codeRows = [['quote_not_verbatim', '意图/期望不是原件逐字子串，或引用指不到', '重组者按原件补正确引用后重交；不改作者原文'], ['missing_without_exit', '真实欠缺却没有具名出口', '写明缺的事实、由谁在何时补，再重交'], ['candidate_signed', '用检索候选当签发依据', '换成产品包声明的规范来源，或把它记为 underdetermined'], ['prerequisite_as_conflict', '把缺前置记成冲突', '改记 missing_prerequisite，交编写阶段补齐'], ['unmarked_load_bearing', '承载语义的适配未标 load_bearing', '标注并给等价条件；不标则该适配不生效'], ['bound_to_bed', '重组产物里出现具体台架事实', '移到编写/计划阶段的重绑定账'], ['atom_dropped', '作者原子/命令出现次数在适配后减少', '缺失次数留作义务，补回或写明作者同意删除的引用']];
write('tables/recompose-codes.json', { schema: 'recompose.codes@1', violations: codeRows.map(([id, when, fix]) => ({ code: 'recompose.' + id, when, fix })), refusals: [], warnings: [] });
const copy = (folder: string, files: string[]) => { for (const file of files) {
    const target = new URL(folder + '/' + file, base);
    mkdirSync(new URL('.', target), { recursive: true });
    let text = readFileSync(new URL(file, base), 'utf8');
    if (file === 'functions/schema.ts')
        text = text.replace("import {addressValue} from './manifest.ts';", "const addressValue=(_kind:string,_value:string):null=>null;");
    if (file.startsWith('functions/generated/'))
        text = text.replaceAll('../../../../../contracts', '../../../../../../contracts');
    else
        text = text.replaceAll('../../../../contracts', '../../../../../contracts');
    writeFileSync(target, text);
} };
for (const folder of ['authority', 'recompose', 'adjudicate'])
    copy(folder, ['functions/text.ts', 'functions/canonical-json.ts', 'functions/schema.ts', 'functions/compile-structure.ts', 'functions/recompose-evidence.ts', 'tables/compile-structure.json', 'tables/recompose-format.json']);
copy('authority', ['functions/recompose-authority.ts', 'tables/recompose-product.schema.json']);
copy('recompose', ['functions/recompose-check.ts', 'tables/recompose-record.schema.json', 'tables/recompose-codes.json', 'functions/generated/command-grammar.ts']);
write('adjudicate/tables/decision.schema.json', obj({ atom: str, state: choice(T.states), load_bearing: { type: 'boolean' }, bed_independent: { type: 'boolean' }, reason: str }));
if (import.meta.main)
    console.log('recompose local schemas and shared stage files generated');
const workflow = read('workflow.json');
const pipeline = workflow.parameters.find((p: any) => p.name === 'pipeline');
if (pipeline) {
    pipeline.schema.enum = T.pipelines;
    write('workflow.json', workflow);
}
