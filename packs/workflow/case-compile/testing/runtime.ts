import TYPED from '../examples/runtime-contract-v2.json' with {type:'json'};
// Invented original-format runner contract. No real runner identifiers or source contents.
import { runtimeDigest } from '../functions/runtime-contract.ts';
export function entry(object: string, method: string, parameters: Array<{ name: string; kind: string; required: boolean; default: string | null }> = []) {
  return { e: object, f: method, python_symbol: `fixture.${method}`, signature: { parameters, required: parameters.filter((p) => p.required).map((p) => p.name), optional: parameters.filter((p) => !p.required).map((p) => p.name), text: '(fixture)' }, g_syntax: 'synthetic argument description', h_semantics: 'synthetic empty output', i_semantics: 'synthetic empty input', dispatch: 'direct_method_call', status: 'enabled', reason: '', status_authority: 'project_policy:excel-authoring-v1', source: { path: 'fixture/runtime.py', line: 1 }, minimum_runtime: 'synthetic-runtime-v2' };
}
export function signRuntime<T extends Record<string, unknown>>(value: T): T & { contract_sha256: string } { return { ...value, contract_sha256: runtimeDigest(value) }; }
export function runtimeDocument() {
  return signRuntime({ schema: 'ist.excel.function-contract', complete: true, runtime: { minimum_version: 'synthetic-runtime-v2', runner_source: 'fixture/runtime.py', runner_sha256: 'a'.repeat(64), found_times_supported: false }, source_hashes: { 'fixture/runtime.py': 'a'.repeat(64) }, objects: [{ name: 'widget-seat', status: 'enabled' }, { name: 'widget-host', status: 'enabled' }, { name: 'widget-check', status: 'enabled' }, { name: 'widget-clock', status: 'enabled' }, { name: 'widget-disabled', status: 'disabled' }], entries: [
    entry('widget-seat', 'configure', [{ name: 'line', kind: 'positional_only', required: true, default: null }, { name: 'auth_token', kind: 'positional_or_keyword', required: false, default: '<redacted>' }]),
    entry('widget-host', 'shell', [{ name: 'command', kind: 'positional_or_keyword', required: true, default: null }]),
    entry('widget-check', 'literal', [{ name: 'expected', kind: 'positional_or_keyword', required: true, default: null }]),
    entry('widget-clock', 'pause', [{ name: 'seconds', kind: 'positional_or_keyword', required: true, default: null }]),
    { ...entry('widget-disabled', 'cycle'), status: 'disabled', reason: 'synthetic unavailable object' },
    { ...entry('widget-seat', 'hidden'), status: 'internal' },
    { ...entry('widget-seat', 'candidate'), certification_candidate: true },
    entry('widget-seat', 'credential', [{ name: 'password', kind: 'positional_or_keyword', required: false, default: '<redacted>' }]),
  ], execute_actions: [], atlas_snapshot: { fixture: true }, certification: { schema: 'ist.excel.capability-certification-set', receipt_count: 0 } });
}
type TypedFixture=Omit<ReturnType<typeof runtimeDocument>,'entries'>&{original:{contract_sha256:string;sha256:string};types:Record<string,any>;roles:Record<string,any>;effects:Record<string,any>;entries:Array<ReturnType<typeof entry>&{typed_authority?:{source:string;parameters:Record<string,{type:string;role:string}>;effects:string[]};certification_candidate?:boolean}>};
export function typedRuntimeDocument():TypedFixture{return structuredClone(TYPED) as unknown as TypedFixture;}
export function profileDocument(contract:{runtime:{minimum_version:string};contract_sha256:string;original?:{contract_sha256:string}} = runtimeDocument()) {
  return { schema: 'runtime-profile@1', synthetic: true, max_wait_seconds: 300, runtime: { minimum_version: contract.runtime.minimum_version, contract_sha256: contract.original?.contract_sha256??contract.contract_sha256 }, bed: 'bed-a', device_count: 2, fold_newlines: [] as Array<{ object: string; method: string }>, workbook: { sheet: 'FixtureSheet', header: ['FixtureId', 'FixturePriority', 'FixtureType', 'FixtureDescription', 'FixtureObject', 'FixtureMethod', 'FixtureData', 'FixtureOutput', 'FixtureInput'], identity_marker: 'FixtureIdentity', range_name: 'FixtureRange', closing_row: ['FixtureEnd', '', '', '', '', '', '', '', ''], autoid_pattern: '^\\d{18}$' }, seats: [{ object: 'widget-seat', device: 'dut0', ordinal: 0 }], hosts: [{ object: 'widget-host', method: 'shell', device: 'client0' }], allowed: [
    { object: 'widget-seat', method: 'configure', parameters: { line: 'device_cli' },reviewed:true },
    { object: 'widget-host', method: 'shell', parameters: { command: 'host_shell' },reviewed:true },
    { object: 'widget-check', method: 'literal', parameters: { expected: 'literal_assertion' },reviewed:true },
    { object: 'widget-clock', method: 'pause', parameters: { seconds: 'wait' },reviewed:true },
  ] };
}
