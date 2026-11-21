// A made-up frozen run for the method and block lookups: the contract, the profile and the bed manifest the Hub's own readers accept
// (runtime-contract@2, runtime-profile@1, test-bed-manifest@1), written the way a run download leaves them (sources.json with the
// file pointers and digests, sources/<slot>.json, run.json with the frozen slot schema). Every name is invented (widget-*); no real
// system, command or address appears (addresses are 192.0.2.0/24 and 2001:db8::/32). Test support only, never pack code.
//
// What it holds, and which test needs it:
//   widget-seat.configure     a device command method: typed, device_cli, a refused access level, a redacted default
//   widget-seat.table_cell    a cell method: cell_effect with a value policy, registered output cell_text, in the block model
//   widget-seat.promoted      a certification candidate the contract promotes: usable
//   widget-seat.candidate     a certification candidate it does not promote: not enabled for the Hub
//   widget-seat.spare         enabled in the contract, typed, not opened by the profile (profile.unopened says why)
//   widget-seat.hidden        internal;  widget-seat.credential  enabled without typed authority and not opened
//   widget-host.shell         a host method: allowed literals (more than the bound) and a declared program with an address prefix
//   widget-check.literal      the literal assertion;  widget-clock.pause  the wait
//   widget-disabled.cycle     a disabled object with a disabled method
//   widget-bulk.c00 … c64     65 certification candidates below one object: more than the bound of a methods listing
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contractCanonical, runtimeDigest, stripAdditions } from '../functions/runtime-contract.ts';
import { methodSourceOf, type MethodSource } from '../functions/contract-lookup.ts';
import { MANIFEST_DOC } from '../functions/test-support.ts';
import { entry, profileDocument, signRuntime, typedRuntimeDocument } from './runtime.ts';
import { frozenSlots } from './frozen-run.ts';

type Doc = Record<string, any>;
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const BASE = `src:${'d'.repeat(64)}/json@1/p`;
export const BULK_METHODS = 65;
export const LITERALS = 45;
export const FIXTURE_RUN = 'run_01cccccccccccccccccccccccc';

/** The literal host lines the fixture's host effect allows in full: more of them than one answer lists. */
export const hostLiterals = (): string[] => Array.from({ length: LITERALS }, (_, i) => `probe @192.0.2.90 name${String(i).padStart(2, '0')}.example A`);

/** Signs a contract the way the Hub's readers expect after a test changed it: the original identity of the stripped document, then the full digest. */
export function signContract(contract: Doc): Doc {
  const original = stripAdditions(contract)!;
  const digest = runtimeDigest(original);
  original.contract_sha256 = digest;
  return signRuntime({ ...contract, original: { contract_sha256: digest, sha256: sha(contractCanonical(original)) } });
}

export interface ContractFixture {
  contract: Doc;
  profile: Doc;
  inventory: Doc;
}

export function contractFixture(): ContractFixture {
  const contract = typedRuntimeDocument() as unknown as Doc;
  const type = (name: string, catalog: string, extra: Doc = {}): Doc => ({ declaration: { name, catalog_type: catalog, declaration: `${BASE}/types/${name}`, grammar: 'runtime-contract@2' }, ...extra });
  const role = (name: string, extra: Doc = {}): Doc => ({ source: `${BASE}/roles/${name}`, ...extra });
  contract.objects = [
    ...contract.objects.map((object: Doc) => ({ e: object.name, python_type: object.name === 'widget-host' ? 'ssh_host' : 'WidgetSeat', status: object.status, reason: object.status === 'enabled' ? 'runner-resolved object with a complete AST/MRO method closure' : 'synthetic unavailable object', status_authority: 'mirror_ast:reachability-and-lifecycle', source: { path: 'fixture/runtime.py', line: 3 } })),
    { e: 'widget-bulk', python_type: 'WidgetBulk', status: 'enabled', reason: 'runner-resolved object with a complete AST/MRO method closure', status_authority: 'mirror_ast:reachability-and-lifecycle', source: { path: 'fixture/runtime.py', line: 4 } },
  ];
  const cellRoles = ['cell_source', 'cell_selection'];
  contract.types = { ...contract.types, probe_name: type('probe_name', 'string', { pattern: '^[a-z][a-z0-9.-]{0,40}$' }), cell_string: type('cell_string', 'string'), cell_int: type('cell_int', 'int'), key_file: type('key_file', 'enum', { values: ['cert/a.pem', 'cert/b.key'] }), channel: type('channel', 'int', { minimum: 1, maximum: 8 }) };
  contract.roles = { ...contract.roles, cell_source: role('cell_source'), cell_selection: role('cell_selection'), runner_option: role('runner_option'), probe_target: role('probe_target', { bed_member: true }) };
  contract.effects.effect_1.allowed_literals = hostLiterals();
  contract.effects.effect_1.allowed_programs = [{ program: 'probe', address_prefix: '@' }];
  contract.effects.effect_1.roles = ['host_shell', 'credential', 'runner_option'];
  contract.effects.cell_selection = { source: `${BASE}/entries/9/cell_effect`, roles: cellRoles, budget: 256, commands: [], allowed_literals: [], command_roles: [] };
  contract.effects.promoted = { source: `${BASE}/entries/10/promoted`, roles: ['device_cli', 'credential'], budget: 3, commands: [], allowed_literals: [], command_roles: [] };
  const typed = (parameters: Record<string, { type: string; role: string }>, effects: string[], source: string) => ({ source, parameters, effects });
  const parameter = (name: string, kind: string, required: boolean, fallback: string | null = null) => ({ name, kind, required, default: fallback });
  const signatureText = (parameters: Array<{ name: string; required: boolean; default: string | null; kind: string }>) => `(${parameters.map((p) => (p.kind === 'var_positional' ? '*' : '') + p.name + (p.required || p.kind === 'var_positional' ? '' : `=${p.default}`)).join(', ')})`;
  const withText = <T extends { signature: { parameters: Array<{ name: string; required: boolean; default: string | null; kind: string }> } }>(row: T): T => ({ ...row, signature: { ...row.signature, text: signatureText(row.signature.parameters) } });
  const rewrite = (object: string, method: string, patch: Doc) => { const row = contract.entries.find((item: Doc) => item.e === object && item.f === method); Object.assign(row, patch); return row; };
  rewrite('widget-seat', 'configure', { signature: { ...contract.entries.find((item: Doc) => item.f === 'configure').signature, text: "(line, auth_token=<redacted>)" }, g_syntax: 'one device command line as text', h_semantics: 'stores the returned text', i_semantics: 'the saved text replaces {} in G', source: { path: 'fixture/runtime.py', line: 21 } });
  rewrite('widget-host', 'shell', { signature: { parameters: [parameter('command', 'positional_or_keyword', true), parameter('timeout', 'keyword_only', false, '10')], required: ['command'], optional: ['timeout'], text: '(command, *, timeout=10)' }, dispatch: 'cmd_primitive', g_syntax: 'one host command line', h_semantics: 'stores the returned text', i_semantics: 'the saved text replaces {} in G', source: { path: 'fixture/runtime.py', line: 40 }, typed_authority: typed({ command: { type: 'text', role: 'host_shell' }, timeout: { type: 'channel', role: 'runner_option' } }, ['effect_1'], `${BASE}/entries/1/typed`) });
  const cellParameters = [parameter('output', 'positional_or_keyword', true), parameter('conditions', 'var_positional', false), parameter('column', 'keyword_only', true), parameter('header', 'keyword_only', false, '0')];
  const more: Doc[] = [
    { ...entry('widget-seat', 'table_cell', cellParameters), signature: { parameters: cellParameters, required: ['output', 'column'], optional: ['conditions', 'header'], text: signatureText(cellParameters) }, g_syntax: 'readable table shape and column equality arguments', h_semantics: 'stores the selected cell text unchanged', i_semantics: 'uses a saved device output as the first positional argument', source: { path: 'fixture/cell.py', line: 286 }, parameter_roles: { output: 'cell_source', conditions: 'cell_selection', column: 'cell_selection', header: 'cell_selection' }, parameter_types: { output: 'cell_string', conditions: 'cell_string', column: 'cell_int', header: 'cell_int' }, cell_effect: { roles: cellRoles, budget: 256, device_calls: false, value_policy: { schema: 'ascii-cell-value@1', characters: 'abc.-', min_length: 1, max_length: 128 } }, typed_authority: typed({ output: { type: 'cell_string', role: 'cell_source' }, conditions: { type: 'cell_string', role: 'cell_selection' }, column: { type: 'cell_int', role: 'cell_selection' }, header: { type: 'cell_int', role: 'cell_selection' } }, ['cell_selection'], `${BASE}/entries/9/cell_effect`) },
    { ...withText(entry('widget-seat', 'promoted', [parameter('line', 'positional_only', true)])), certification_candidate: true, status_authority: `device_receipt_set:${'e'.repeat(64)}`, reason: 'every seat binding passed device certification', typed_authority: typed({ line: { type: 'text', role: 'device_cli' } }, ['promoted'], `${BASE}/entries/10/typed`) },
    { ...withText(entry('widget-seat', 'spare', [parameter('line', 'positional_only', true), parameter('key', 'positional_or_keyword', false, "'cert/a.pem'")])), typed_authority: typed({ line: { type: 'text', role: 'device_cli' }, key: { type: 'key_file', role: 'credential' } }, ['effect_0'], `${BASE}/entries/11/typed`) },
    ...Array.from({ length: BULK_METHODS }, (_, i) => ({ ...entry('widget-bulk', `c${String(i).padStart(2, '0')}`, [parameter('x', 'positional_or_keyword', true)]), certification_candidate: true, status_authority: `device_receipt_set:${'f'.repeat(64)}` })),
  ];
  contract.entries.push(...more);
  contract.promotions = [{ object: 'widget-seat', method: 'promoted', status_authority: `device_receipt_set:${'e'.repeat(64)}`, reason: 'the final release replay is the dispatch of a workbook that uses it' }];
  contract.refused_access = { source: 'fixture/runtime.py', sha256: 'a'.repeat(64), rows: [{ object: 'widget-seat', method: 'configure', access: ['LEVEL_X', 'LEVEL_Y'] }] };
  contract.runtime = {
    ...contract.runtime,
    block_model: {
      schema: 'case-compile.block-runtime@1',
      default_assertion: { object: 'widget-check', method: 'literal' },
      operators: [{ op: 'found', expected: 'literal', object: 'widget-check', method: 'literal', matching: 'escaped_literal' }],
      output_methods: [{ object: 'widget-seat', method: 'configure', output: 'raw_text' }, { object: 'widget-seat', method: 'table_cell', output: 'cell_text' }, { object: 'widget-host', method: 'shell', output: 'raw_text' }],
      reserved_registers: ['widget-seat', 'widget-host'],
      capture_registers: true,
      cell_methods: [{ object: 'widget-seat', method: 'table_cell' }],
      cell_inputs: true,
    },
  };
  const signed = signContract(contract);

  const profile = profileDocument(signed as never) as unknown as Doc;
  profile.block_model = true;
  profile.hosts = [{ object: 'widget-host', method: 'shell', device: 'client0' }];
  profile.allowed = [
    ...profile.allowed.filter((row: Doc) => !(row.object === 'widget-host' && row.method === 'shell')),
    { object: 'widget-host', method: 'shell', parameters: { command: 'host_shell', timeout: 'runner_option' }, reviewed: true },
    { object: 'widget-seat', method: 'table_cell', parameters: { output: 'cell_source', conditions: 'cell_selection', column: 'cell_selection', header: 'cell_selection' }, reviewed: true },
    { object: 'widget-seat', method: 'promoted', parameters: { line: 'device_cli' }, reviewed: true },
  ];
  profile.unopened = [{ object: 'widget-seat', method: 'spare', parameters: [{ name: 'line', missing: 'synthetic: the method is not reviewed', reason: 'synthetic: the integrator has not read the method', next: 'synthetic: review it and open it in the next publication' }] }];

  const inventory = structuredClone(MANIFEST_DOC) as Doc;
  return { contract: signed, profile, inventory };
}

/** What the lookup reads of a download, parsed by the Hub's own readers; throws with their first problem when the fixture is invalid. */
export function methodSource(from: ContractFixture = contractFixture(), options: { references?: boolean } = {}): MethodSource {
  const file = (name: string, document: unknown) => ({ file: `sources/${name}.json`, reference: options.references === false ? null : `src:${sha(JSON.stringify(document))}` });
  return methodSourceOf({ contract: from.contract, profile: from.profile, inventory: from.inventory }, { contract: file('contract', from.contract), profile: file('profile', from.profile), inventory: file('inventory', from.inventory) });
}

export interface DownloadOptions {
  /** Leave sources.json out: the root-level layout of old fetch-run directories. */
  withoutManifest?: boolean;
  /** Leave out run.json's frozen slot schema. */
  withoutSlots?: boolean;
  /** Replace the bytes of one source file after its digest was written to sources.json. */
  tamper?: 'contract' | 'profile' | 'inventory';
}

/** Writes run.json with sources.json and sources/<slot>.json beside it, the way the download tool leaves a run; returns the path of run.json. */
export async function writeContractDownload(directory: string, from: ContractFixture = contractFixture(), options: DownloadOptions = {}): Promise<string> {
  await mkdir(join(directory, 'sources'), { recursive: true });
  const slots = [['contract', from.contract], ['inventory', from.inventory], ['profile', from.profile]] as const;
  const manifest: Doc[] = [];
  for (const [slot, document] of slots) {
    const bytes = Buffer.from(JSON.stringify(document));
    const file = options.withoutManifest ? `${slot}.json` : `sources/${slot}.json`;
    await writeFile(join(directory, file), options.tamper === slot ? Buffer.from(JSON.stringify({ ...document, tampered: true })) : bytes);
    manifest.push({ slot, role: 'expected', reference: `src:${sha(bytes)}`, label: `named document ${slot}`, media_type: 'application/json', file, sha256: sha(bytes) });
  }
  if (!options.withoutManifest) await writeFile(join(directory, 'sources.json'), JSON.stringify(manifest));
  const run = { run: FIXTURE_RUN, root: sha('contract fixture root'), product: 'widget', version: '1.0', build: 'Rel_WIDGET_1', groups: [], items: [], ...(options.withoutSlots ? {} : { slots: frozenSlots() }) };
  const file = join(directory, 'run.json');
  await writeFile(file, JSON.stringify(run));
  return file;
}
