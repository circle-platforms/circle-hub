import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { interfaceDigest, parseRuntimeContract, runtimeDigest, stripAdditions } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import CONTRACT_FORMAT from '../../../packs/workflow/case-compile/tables/runtime-contract-format.json' with { type: 'json' };

const COMPONENT = dirname(fileURLToPath(import.meta.url));
const env = { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' };
const prefix = `import sys,json\nsys.path.insert(0,sys.argv[1])\n`;
function python(code: string, value: unknown, args: string[] = []) {
  const result = spawnSync('python3', ['-c', prefix + code, COMPONENT, ...args], {
    input: JSON.stringify(value), encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}
function select(output: string, conditions: string[], options: Record<string, unknown>) {
  return python(`from table_cell import table_cell,CellSelectionError,CELL_VALUE_POLICY
p=json.load(sys.stdin)
p['options']['value_policy']=CELL_VALUE_POLICY
try: print(json.dumps({'value':table_cell(p['output'],*p['conditions'],**p['options'])}))
except CellSelectionError as error: print(json.dumps({'error':str(error)}))
`, { output, conditions, options: { separator: '+', columns: 3, column: 3, ...options } });
}

test('shape recognition and all declared column conditions select one cell without dropping leading zeroes', () => {
  const output = 'command echo\n\nother+public+00222\nsample+private+00333\nprompt#\nsample+public+00123\n';
  assert.equal(select(output, ['where 1=sample', 'where 2=public'], {}).value, '00123');
  assert.equal(select('00123+text\n123+other', ['where 1=00123'], { columns: 2, column: 2 }).value, 'text');
});

test('header, row selection and key-value rows use their declared structure', () => {
  assert.equal(select('echo\nName+Kind+Value\nsample+public+00789\nprompt#', [], { header: 1, row: 1 }).value, '00789');
  assert.equal(select('echo\nName:00123\nOther:part:rest\nprompt#', ['where 1=Other'], {
    format: 'key_value', separator: ':', columns: 2, column: 2,
  }).value, 'part:rest');
  assert.equal(select('echo\nKey:Value\nName:00123', [], {
    format: 'key_value', separator: ':', columns: 2, column: 2, header: 1, row: 1,
  }).value, '00123');
});

test('six declared filename segments select an exact key suffix and retain the observed identifier', () => {
  const lines = ['Kother.example.+008+00009+ksk+synthetic+2048.key',
    'Kzone.example.+008+00123+ksk+synthetic+2048.private',
    'Kzone.example.+008+00123+ksk+synthetic+2048.key',
    'Kzone.example.+008+00456+zsk+synthetic+2048.key'];
  const conditions = ['where 1=Kzone.example.', 'where 4=ksk', 'where 6=2048.key'];
  assert.equal(select(lines.join('\n'), conditions, {columns: 6, column: 3}).value, '00123');
  const duplicate = select([...lines, 'Kzone.example.+008+00789+ksk+synthetic+2048.key'].join('\n'), conditions, {columns: 6, column: 3});
  assert.match(duplicate.error, /选中2行/);
});

// Round 36: the key listing of a 200-character host. The shapes and lengths are those of the read-only probe of the bed's
// "show sdns dnssec keygen" (echo, two lines per key, prompt; a .key line of a 200-character host is 233 characters). Synthetic names only.
const KEY_LABEL = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz';
const KEY_HOST = [KEY_LABEL, KEY_LABEL, KEY_LABEL, 'example.com'].join('.');
const OTHER_KEY_HOST = [[...KEY_LABEL].reverse().join(''), KEY_LABEL, KEY_LABEL, 'example.net'].join('.');
const keyLines = (host: string, keys: Array<[string, string]>) => keys.flatMap(([kind, id]) => ['key', 'private'].map(ext => `K${host}.+005+${id}+${kind}+RSASHA1+1024.${ext}`));
const listing = (lines: string[], eol = '\r\n') => [`show sdns dnssec keygen "${KEY_HOST}"`, ...lines, 'APV#'].join(eol) + eol;
const pinned = (kind: string) => [`where 1=K${KEY_HOST}.`, 'where 2=005', `where 4=${kind}`, 'where 5=RSASHA1', 'where 6=1024.key'];
const KEY_SHAPE = { columns: 6, column: 3 };
// What the runner makes of "{}" in the first argument of the command that uses the picked cell: the whole value, in place.
const keypub = (kind: string, id: string) => `sdns dnssec keypub "${KEY_HOST}" "${kind}" "K${KEY_HOST}.+005+{}+${kind}+RSASHA1+1024"`.replace('{}', id);

test('a key listing of a 200-character host yields the generated key id; the fixed segments of the key name stay in the command that uses it', () => {
  assert.equal(KEY_HOST.length, 200);
  assert.equal(OTHER_KEY_HOST.length, 200);
  const own = keyLines(KEY_HOST, [['zsk', '27457'], ['ksk', '51877']]);
  assert.equal(own[0].length, 233, 'the .key line of a 200-character host');
  assert.equal(own[1].length, 237, 'the .private line');
  const residue = keyLines(OTHER_KEY_HOST, [['zsk', '00112'], ['ksk', '32329']]);
  for (const eol of ['\r\n', '\n']) for (const output of [listing(own, eol), listing([...residue, ...own], eol), listing([...own, ...residue], eol)]) {
    assert.deepEqual([select(output, pinned('ksk'), KEY_SHAPE).value, select(output, pinned('zsk'), KEY_SHAPE).value], ['51877', '27457']);
  }
  // The key name the device is given is the manual's form, 229 characters, far above what one picked cell may hold.
  const name = (kind: string, id: string) => /"(K[^"]+)"$/.exec(keypub(kind, id))![1];
  assert.equal(name('ksk', '51877'), `K${KEY_HOST}.+005+51877+ksk+RSASHA1+1024`);
  assert.equal(name('ksk', '51877').length, 229);
  // One picked cell may hold up to 255 characters (a file name's bound): a whole 233-character key line is a cell, a longer line is not.
  const whole = select(listing(own), [], { separator: '', columns: 1, column: 1, row: 4 });
  assert.equal(whole.error, undefined, JSON.stringify(whole));
  assert.ok(String(whole.value).length >= 229 && String(whole.value).length <= 255);
  const longer = select('K' + 'x'.repeat(300), [], { separator: '', columns: 1, column: 1, row: 1 });
  assert.match(longer.error, /取格值长度不在规则声明的1到255之间/);
});

test('a key listing that does not name exactly one key of the declared kind is refused with the device words, and the fixed segments are checked against what the device printed', () => {
  const own = keyLines(KEY_HOST, [['zsk', '27457'], ['ksk', '51877']]);
  // A second key of the same host and kind (an earlier run did not reach its cleanup): two rows, nothing is guessed.
  const twice = listing([...own, ...keyLines(KEY_HOST, [['ksk', '99999']])]);
  const refused = select(twice, pinned('ksk'), KEY_SHAPE);
  assert.match(refused.error, /选中2行/);
  assert.ok(refused.error.includes('51877') && refused.error.includes('99999'), 'the device words are attached');
  assert.equal(select(twice, pinned('zsk'), KEY_SHAPE).value, '27457');
  // Another algorithm, size or suffix than the command repeats: no row, so no id is poured into a name that would not match.
  for (const output of [listing(own).replaceAll('+005+', '+008+'), listing(own).replaceAll('RSASHA1+1024', 'RSASHA256+2048'), listing(own).replaceAll('.key', '.pub')]) {
    assert.match(select(output, pinned('ksk'), KEY_SHAPE).error, /选中0行/);
  }
  // The host column is pinned too: a listing of another host alone gives no row.
  assert.match(select(listing(keyLines(OTHER_KEY_HOST, [['ksk', '32329']])), pinned('ksk'), KEY_SHAPE).error, /选中0行/);
});

test('zero, multiple, malformed-width and missing-column outcomes say why and carry the original output', () => {
  for (const [output, conditions, options, reason] of [
    ['sample+public+00123', ['where 1=absent'], {}, '选中0行'],
    ['sample+public+00123\nsample+public+00456', ['where 1=sample'], {}, '选中2行'],
    ['sample+public\nprompt#', ['where 1=sample'], {}, '没有符合声明形状'],
    ['sample+public+00123', ['where 1=sample'], { column: 4 }, '指定列不存在'],
    ['sample+public+00123', ['where 4=sample'], {}, '条件列不存在'],
    ['sample+public+00123', [], { row: 3 }, '选中0行'],
    ['sample+public+00123', ['where 1=sample'], { row: 1 }, '二选一'],
  ] as Array<[string, string[], Record<string, unknown>, string]>) {
    const result = select(output, conditions, options);
    assert.ok(result.error.includes('取不到'), result.error);
    assert.ok(result.error.includes(reason), result.error);
    assert.ok(result.error.includes(output), result.error);
    assert.ok(result.error.includes('位置'), result.error);
  }
});

const FRAMEWORK = `import csv,json
from pathlib import Path
EXCEL_FUNCTION_CONTRACT_VERSION='synthetic-runtime'
def _contract_shape_valid(document): return isinstance(document['objects'],list)
def _load_excel_contract():
    return json.loads(Path(__file__).with_name('excel_contract.json').read_text())
def _parameters(text):
    args=[];keywords={}
    for part in next(csv.reader([text],skipinitialspace=True)):
        left,equal,right=part.partition('=')
        if equal and ' ' not in left:
            keywords[left]=int(right) if right.isdecimal() else right
        else: args.append(part)
    return args,keywords
def test_xlsx(request,apv_xlsx,logger,configer,check_point,db,xlsx_file):
    workbook=json.loads(Path(xlsx_file).read_text())
    assert workbook['contract']==_load_excel_contract()['contract_sha256']
    objects={'Device_0':apv_xlsx('synthetic',0)}
    registers={};result=None
    for row in workbook['rows']:
        if row[0]: registers.clear();result=None
        args,keywords=_parameters(row[6])
        if row[8]: args[0]=args[0].format(registers[row[8]])
        value=getattr(objects[row[4]],row[5])(*args,**keywords)
        if row[7]: registers[row[7]]=value
        else: result=value
    return {'registers':registers,'result':result}
`;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value)!;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cell-executor-'));
  const framework = join(root, 'framework');
  mkdirSync(join(framework, 'lib'), { recursive: true });
  mkdirSync(join(framework, 'smoke_test'));
  writeFileSync(join(framework, 'lib/test_xlsx.py'), FRAMEWORK);
  writeFileSync(join(framework, 'smoke_test/conftest.py'), 'SYNTHETIC = True\n');
  const original: Record<string, unknown> = {
    schema: 'ist.excel.function-contract', complete: true,
    runtime: { minimum_version: 'synthetic-runtime', runner_source: 'lib/test_xlsx.py', runner_sha256: sha(FRAMEWORK), found_times_supported: false },
    source_hashes: { 'lib/test_xlsx.py': sha(FRAMEWORK), 'smoke_test/conftest.py': sha('SYNTHETIC = True\n') },
    objects: [{ e: 'Device_0', status: 'enabled', status_authority: 'project_policy:excel-authoring-v1' }],
    entries: [{ e: 'Device_0', f: 'configure', python_symbol: 'synthetic.configure', status: 'enabled',
      status_authority: 'project_policy:excel-authoring-v1', reason: '', dispatch: 'cmd_primitive',
      source: { path: 'lib/test_xlsx.py', line: 1 }, minimum_runtime: 'synthetic-runtime',
      signature: { parameters: [{ name: 'line', kind: 'positional_or_keyword', required: true, default: null }], required: ['line'], optional: [], text: '(line)' },
      g_syntax: 'one literal argument', h_semantics: 'stores returned text', i_semantics: 'first-argument input',
    }],
    execute_actions: [{ normalized: 'unopened', status: 'disabled' }],
    atlas_snapshot: { synthetic: true },
    certification: { schema: 'ist.excel.capability-certification-set', receipt_count: 0 },
  };
  original.contract_sha256 = sha(canonical(original));
  const base = join(framework, 'lib/excel_contract.json');
  writeFileSync(base, JSON.stringify(original));
  const exported = join(root, 'cell-contract.json');
  const command = spawnSync('python3', [join(COMPONENT, 'entry.py'), 'export-contract', '--framework-root', framework, '--base-contract', base, '--object', 'Device_0', '--out', exported], { encoding: 'utf8', env });
  assert.equal(command.status, 0, command.stderr || String(command.error));
  return { root, framework, original, exported, document: JSON.parse(readFileSync(exported, 'utf8')), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('contract export reads verified files without executing framework or device fixture modules', () => {
  const f = fixture();
  try {
    const poisonous = 'raise RuntimeError("synthetic import must never run")\n';
    for (const relative of ['lib/test_xlsx.py', 'smoke_test/conftest.py']) {
      writeFileSync(join(f.framework, relative), poisonous);
      (f.original.source_hashes as Record<string, string>)[relative] = sha(poisonous);
    }
    (f.original.runtime as Record<string, unknown>).runner_sha256 = sha(poisonous);
    const { contract_sha256: ignored, ...unsigned } = f.original;
    f.original.contract_sha256 = sha(canonical(unsigned));
    const base = join(f.framework, 'lib/excel_contract.json');
    writeFileSync(base, JSON.stringify(f.original));
    const exported = join(f.root, 'no-import-contract.json');
    const args = [join(COMPONENT, 'entry.py'), 'export-contract', '--framework-root', f.framework,
      '--base-contract', base, '--object', 'Device_0', '--out', exported];
    const result = spawnSync('python3', args, { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(exported, 'utf8')).source_hashes['lib/test_xlsx.py'], sha(poisonous));
    writeFileSync(join(f.framework, 'lib/test_xlsx.py'), poisonous + '# changed\n');
    args[args.length - 1] = join(f.root, 'rejected-contract.json');
    const rejected = spawnSync('python3', args, { encoding: 'utf8', env });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /来源文件与实际内容不同/);
    writeFileSync(join(f.framework, 'lib/test_xlsx.py'), poisonous);
    (f.original.entries as Array<{ source: { path: string } }>)[0].source.path = 'lib/undeclared.py';
    const { contract_sha256: prior, ...withoutIdentity } = f.original;
    f.original.contract_sha256 = sha(canonical(withoutIdentity));
    writeFileSync(base, JSON.stringify(f.original));
    const missing = spawnSync('python3', args, { encoding: 'utf8', env });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /方法来源未登记文件摘要/);
  } finally { f.close(); }
});

const FLOW = `from cell_runtime import Runtime
from pathlib import Path
from types import SimpleNamespace
p=json.load(sys.stdin);calls=[];failed=[]
class Check:
    def abs_found(self,expect,result):
        if expect not in result: failed.append(result)
class Device:
    def configure(self,line):
        calls.append(line)
        return p['output'] if line=='observe' else line
try:
    value=Runtime(p['framework'],p['contract']).invoke(SimpleNamespace(),lambda *args:Device(),None,None,Check() if p.get('checkpoint') else None,None,p['workbook'])
    print(json.dumps({'value':value,'calls':calls,'failed':failed}))
except Exception as error: print(json.dumps({'error':str(error),'calls':calls,'failed':failed}))
`;
function workbook(f: ReturnType<typeof fixture>, privatePin = interfaceDigest(f.document)) {
  const file = join(f.root, 'case.xlsx');
  writeFileSync(file, JSON.stringify({ contract: privatePin, rows: [
    ['synthetic-case', '', '', '', 'Device_0', 'configure', 'observe', 'raw', ''],
    ['', '', '', '', 'Device_0', 'table_cell', '{},where 1=sample,where 2=public,column=3,columns=3,header=0,separator=+', 'picked', 'raw'],
    ['', '', '', '', 'Device_0', 'configure', 'use {}', '', 'picked'],
  ] }));
  return file;
}

test('the exported rule covers actual framework and component files, retains closed actions and has a new identity', () => {
  const f = fixture();
  try {
    assert.notEqual(f.document.contract_sha256, f.original.contract_sha256);
    assert.deepEqual(f.document.execute_actions, f.original.execute_actions);
    assert.equal(f.document.certification.receipt_count, 0);
    assert.equal(f.document.runtime.runner_source, 'cell-runtime/test_xlsx.py');
    for (const [file, digest] of Object.entries(f.document.source_hashes)) {
      const source = file.startsWith('cell-runtime/') ? join(COMPONENT, file.slice('cell-runtime/'.length)) : join(f.framework, file);
      assert.equal(digest, sha(readFileSync(source)));
    }
    const entry = f.document.entries.find((item: { f: string }) => item.f === 'table_cell');
    assert.deepEqual(entry.signature.required, ['output', 'separator', 'columns', 'column']);
    assert.equal(entry.signature.parameters.find((item: { name: string }) => item.name === 'conditions').kind, 'var_positional');
    assert.equal(entry.parameter_roles.output, 'cell_source');
    assert.deepEqual(entry.cell_effect.value_policy, {schema:'ascii-cell-value@1',characters:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+:-',min_length:1,max_length:255});
    assert.equal(readFileSync(join(f.framework, 'lib/test_xlsx.py'), 'utf8'), FRAMEWORK);
  } finally { f.close(); }
});

test('Hub declarations restore the actual new original, inherit unchanged source claims and reference new cell declarations', () => {
  const f = fixture();
  try {
    const base = structuredClone(f.original) as any;
    base.schema = 'runtime-contract@2';
    base.original = { contract_sha256: f.original.contract_sha256, sha256: sha(readFileSync(join(f.framework, 'lib/excel_contract.json'))) };
    base.runtime.block_model = { schema: 'case-compile.block-runtime@1', capture_registers: true, reserved_registers: [], output_methods: [{ object: 'Device_0', method: 'configure', output: 'raw_text' }] };
    base.runtime.checkpoint_two_argument = true;
    const source = 'src:' + 'a'.repeat(64);
    base.types = { legacy: { declaration: { name: 'legacy', declaration: source, grammar: 'runtime-contract@2', catalog_type: 'string' } } };
    base.roles = { device_cli: { source } };
    base.effects = { legacy: { source, roles: ['device_cli'], budget: 256, allowed_literals: [], command_roles: [] } };
    base.destructive = { source: 'synthetic/policy.txt', sha256: 'b'.repeat(64), exact: ['/commands/synthetic/stop'], prefixes: [], segments: [] };
    base.exec_failure_markers = { source: 'synthetic/failure-policy.txt', sha256: 'c'.repeat(64), lines: ['synthetic operation refused'] };
    base.entries[0].typed_authority = { source, parameters: { line: { type: 'legacy', role: 'device_cli' } }, effects: ['legacy'] };
    base.contract_sha256 = runtimeDigest(base);
    const baseFile = join(f.root, 'base-hub.json');
    const hubFile = join(f.root, 'cell-hub.json');
    writeFileSync(baseFile, JSON.stringify(base));
    const result = spawnSync('python3', [join(COMPONENT, 'entry.py'), 'export-hub-contract', '--original', f.exported, '--base-hub-contract', baseFile, '--out', hubFile], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const hub = JSON.parse(readFileSync(hubFile, 'utf8'));
    assert.deepEqual(stripAdditions(hub), f.document);
    assert.equal(hub.original.sha256, sha(readFileSync(f.exported)));
    const read = parseRuntimeContract(hub);
    assert.equal(read.ok, true, JSON.stringify(read));
    // The Hub rule says both identities of its original; the package recomputes both and takes the interface identity as the pin.
    assert.equal(hub.original.interface_sha256, interfaceDigest(f.document));
    assert.equal(JSON.parse(result.stdout).interface_sha256, hub.original.interface_sha256);
    if (read.ok) assert.deepEqual(read.contract.pinned, { identity: hub.original.interface_sha256, build: f.document.contract_sha256, bytes: hub.original.sha256 });
    const forged = structuredClone(hub); forged.original.interface_sha256 = 'c'.repeat(64); forged.contract_sha256 = runtimeDigest(forged);
    const refused = parseRuntimeContract(forged);
    assert.ok(!refused.ok && refused.problems.some((problem) => problem.pointer === '/original/interface_sha256'), JSON.stringify(refused));
    assert.deepEqual(hub.entries[0].typed_authority, base.entries[0].typed_authority);
    assert.deepEqual(hub.destructive, base.destructive);
    assert.deepEqual(hub.exec_failure_markers, base.exec_failure_markers);
    assert.equal(hub.runtime.block_model.cell_inputs, true);
    assert.deepEqual(hub.runtime.block_model.cell_methods, [{ object: 'Device_0', method: 'table_cell' }]);
    const added = hub.entries.find((item: { f: string }) => item.f === 'table_cell');
    const originalCell = f.document.entries.find((item: { f: string }) => item.f === 'table_cell');
    assert.deepEqual(added.cell_effect.value_policy, originalCell.cell_effect.value_policy);
    assert.equal(added.cell_effect.value_policy.schema, 'ascii-cell-value@1');
    assert.equal(added.cell_effect.value_policy.min_length, 1);
    assert.equal(added.cell_effect.value_policy.max_length, 255);
    assert.equal(added.cell_effect.value_policy.characters, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+:-');
    assert.deepEqual(added.typed_authority.effects, ['cell_selection']);
    assert.equal(hub.effects.cell_selection.budget, 256);
    assert.deepEqual(hub.effects.cell_selection.roles, ['cell_source', 'cell_selection']);
    assert.ok(added.typed_authority.source.startsWith('src:' + hub.original.sha256 + '/json@1/p/entries/'));
    assert.deepEqual(hub.execute_actions, f.original.execute_actions);
    assert.equal(hub.certification.receipt_count, 0);
    base.original.contract_sha256 = 'b'.repeat(64);
    base.contract_sha256 = runtimeDigest(base);
    writeFileSync(baseFile, JSON.stringify(base));
    const bad = spawnSync('python3', [join(COMPONENT, 'entry.py'), 'export-hub-contract', '--original', f.exported, '--base-hub-contract', baseFile, '--out', join(f.root, 'bad.json')], { encoding: 'utf8', env });
    assert.notEqual(bad.status, 0);
    assert.ok(bad.stderr.includes('原始来源不对应'));
  } finally { f.close(); }
});

// What a rule's two identities are for: the whole digest says which bytes run and is held against the files when a run starts;
// the interface identity is what a workbook carries and the private entry pins. Both sides compute the interface identity (the
// component in Python, the Hub's package in TypeScript), so they are compared here on the same documents.
function resign(document: Record<string, unknown>) {
  const { contract_sha256: _, ...unsigned } = document;
  document.contract_sha256 = sha(canonical(unsigned));
  return document;
}
function reexport(f: ReturnType<typeof fixture>, name: string) {
  const base = join(f.framework, 'lib/excel_contract.json');
  writeFileSync(base, JSON.stringify(resign(f.original)));
  const out = join(f.root, name);
  const command = spawnSync('python3', [join(COMPONENT, 'entry.py'), 'export-contract', '--framework-root', f.framework, '--base-contract', base, '--object', 'Device_0', '--out', out], { encoding: 'utf8', env });
  assert.equal(command.status, 0, command.stderr || String(command.error));
  return { file: out, document: JSON.parse(readFileSync(out, 'utf8')), printed: JSON.parse(command.stdout) };
}

test('the component and the package compute one interface identity, from the same list of members left out', () => {
  const f = fixture();
  try {
    const sides = python(`import cell_runtime as c
p=json.load(sys.stdin)
print(json.dumps({'digest':c.interface_digest(p),'whole':c.contract_digest(p),'omitted':c.INTERFACE_OMITTED,'runtime_omitted':c.INTERFACE_RUNTIME_OMITTED,'source_in':c.INTERFACE_SOURCE_IN,'source_omitted':c.INTERFACE_SOURCE_OMITTED,'receipt':c.RECEIPT_AUTHORITY}))
`, f.document);
    assert.equal(sides.digest, interfaceDigest(f.document));
    assert.equal(sides.whole, f.document.contract_sha256);
    assert.notEqual(sides.digest, sides.whole);
    assert.deepEqual({ omitted: sides.omitted, runtime_omitted: sides.runtime_omitted, source_in: sides.source_in, source_omitted: sides.source_omitted }, CONTRACT_FORMAT.interface);
    assert.equal(sides.receipt, CONTRACT_FORMAT.receipt_authority_prefix);
  } finally { f.close(); }
});

test('a repair that changes a source and nothing declared keeps the interface identity, and a workbook compiled before it still runs', () => {
  const f = fixture();
  try {
    const before = interfaceDigest(f.document), compiled = workbook(f);
    // The framework's runner gets a line more: its digest, the runner digest and the line of a declaration below it change.
    const repaired = '# repaired\n' + FRAMEWORK;
    writeFileSync(join(f.framework, 'lib/test_xlsx.py'), repaired);
    (f.original.source_hashes as Record<string, string>)['lib/test_xlsx.py'] = sha(repaired);
    (f.original.runtime as Record<string, unknown>).runner_sha256 = sha(repaired);
    (f.original.entries as Array<{ source: { line: number }; status_authority: string }>)[0].source.line = 2;
    // Evidence records change with a repair too: the snapshot, the certification set and the receipts behind a status.
    f.original.atlas_snapshot = { synthetic: true, rebuilt: 2 };
    f.original.certification = { schema: 'ist.excel.capability-certification-set', receipt_count: 1, receipt_set_sha256: 'd'.repeat(64) };
    (f.original.objects as Array<{ status_authority: string }>)[0].status_authority = 'device_receipt_set:' + 'e'.repeat(64);
    const first = reexport(f, 'repaired-contract.json');
    (f.original.objects as Array<{ status_authority: string }>)[0].status_authority = 'device_receipt_set:' + 'f'.repeat(64);
    const next = reexport(f, 'recertified-contract.json');
    assert.notEqual(first.document.contract_sha256, f.document.contract_sha256);
    assert.notEqual(next.document.contract_sha256, first.document.contract_sha256);
    assert.equal(interfaceDigest(next.document), interfaceDigest(first.document), 'other receipts behind the same status are the same interface');
    assert.equal(next.printed.interface_sha256, interfaceDigest(next.document));
    // The kind of authority a status stands on is declared, so the step from policy to receipts did change the interface.
    assert.notEqual(interfaceDigest(first.document), before);
    (f.original.objects as Array<{ status_authority: string }>)[0].status_authority = 'project_policy:excel-authoring-v1';
    const same = reexport(f, 'same-interface-contract.json');
    assert.notEqual(same.document.contract_sha256, f.document.contract_sha256);
    assert.equal(interfaceDigest(same.document), before);
    const result = python(FLOW, { framework: f.framework, contract: same.file, workbook: compiled, output: 'sample+public+00123' });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.calls, ['observe', 'use 00123']);
    // The rule exported before the repair no longer matches the files: the start of a run refuses it, whatever the workbook says.
    const stale = python(FLOW, { framework: f.framework, contract: f.exported, workbook: compiled, output: 'sample+public+00123' });
    assert.deepEqual(stale.calls, []);
    assert.ok(stale.error.includes('实际加载文件与执行器规则不一致'));
  } finally { f.close(); }
});

test('a changed declaration is another interface: the workbook compiled for the old one is refused, and so is one that carries the whole digest', () => {
  const f = fixture();
  try {
    const compiled = workbook(f);
    const whole = python(FLOW, { framework: f.framework, contract: f.exported, workbook: workbook(f, f.document.contract_sha256), output: 'sample+public+00123' });
    assert.deepEqual(whole.calls, []);
    assert.ok(typeof whole.error === 'string');
    const before = interfaceDigest(f.document);
    (f.original.entries as Array<{ g_syntax: string }>)[0].g_syntax = 'two literal arguments';
    const changed = reexport(f, 'changed-contract.json');
    assert.notEqual(interfaceDigest(changed.document), before);
    const old = python(FLOW, { framework: f.framework, contract: changed.file, workbook: compiled, output: 'sample+public+00123' });
    assert.deepEqual(old.calls, []);
    assert.ok(typeof old.error === 'string');
    const current = python(FLOW, { framework: f.framework, contract: changed.file, workbook: workbook(f, interfaceDigest(changed.document)), output: 'sample+public+00123' });
    assert.deepEqual(current.calls, ['observe', 'use 00123']);
  } finally { f.close(); }
});

test('the private entry saves output, selects a cell and fills the next ordinary command through H/I', () => {
  const f = fixture();
  try {
    const file = workbook(f);
    const result = python(FLOW, { framework: f.framework, contract: f.exported, workbook: file, output: 'echo\nother+public+00999\nsample+private+00222\nsample+public+00123\nprompt#' });
    assert.deepEqual(result.calls, ['observe', 'use 00123']);
    assert.equal(result.value.registers.picked, '00123');
    assert.equal(result.value.result, 'use 00123');
    assert.equal(JSON.parse(readFileSync(join(f.framework, 'lib/excel_contract.json'), 'utf8')).contract_sha256, f.original.contract_sha256);
  } finally { f.close(); }
});

test('with the framework\'s checkpoint a cell that cannot be picked fails its own case, sends no command that would carry it, and the next case runs', () => {
  const f = fixture();
  try {
    // Two cases in one workbook: the first selects two rows, the second selects one.
    const file = join(f.root, 'two.xlsx');
    writeFileSync(file, JSON.stringify({ contract: interfaceDigest(f.document), rows: [
      ['synthetic-case-1', '', '', '', 'Device_0', 'configure', 'observe', 'raw', ''],
      ['', '', '', '', 'Device_0', 'table_cell', '{},where 1=sample,where 2=public,column=3,columns=3,header=0,separator=+', 'picked', 'raw'],
      ['', '', '', '', 'Device_0', 'configure', 'use {}', '', 'picked'],
      ['', '', '', '', 'Device_0', 'configure', 'undo all', '', ''],
      ['synthetic-case-2', '', '', '', 'Device_0', 'configure', 'observe', 'raw', ''],
      ['', '', '', '', 'Device_0', 'table_cell', '{},where 1=sample,where 2=private,column=3,columns=3,header=0,separator=+', 'picked', 'raw'],
      ['', '', '', '', 'Device_0', 'configure', 'use {}', '', 'picked'],
    ] }));
    const output = 'sample+public+00123\nsample+public+00456\nsample+private+00222';
    const result = python(FLOW, { framework: f.framework, contract: f.exported, workbook: file, output, checkpoint: true });
    assert.equal(result.error, undefined, JSON.stringify(result));
    // The command that would carry the unpicked cell is not sent; the case's other step and the whole second case are.
    assert.deepEqual(result.calls, ['observe', 'undo all', 'observe', 'use 00222']);
    assert.equal(result.failed.length, 1, 'one failed checkpoint, for the first case');
    assert.ok(result.failed[0].includes('取不到') && result.failed[0].includes('选中2行') && result.failed[0].includes('sample+public+00456'), 'the position and the device words are in the record');
    assert.equal(result.value.registers.picked, '00222');
    // An unsafe cell is handled the same way: it never reaches a command, and the case is failed, not the workbook.
    const unsafe = python(FLOW, { framework: f.framework, contract: f.exported, workbook: workbook(f), output: 'sample+public+a b', checkpoint: true });
    assert.equal(unsafe.error, undefined, JSON.stringify(unsafe));
    assert.deepEqual(unsafe.calls, ['observe']);
    assert.equal(unsafe.failed.length, 1);
    assert.equal(unsafe.value.registers.picked, 'cell-not-selected');
  } finally { f.close(); }
});

test('without a checkpoint to record on, a cell failure stops later commands, and an edited loaded source is refused', () => {
  const f = fixture();
  try {
    const file = workbook(f);
    const result = python(FLOW, { framework: f.framework, contract: f.exported, workbook: file, output: 'sample+public+00123\nsample+public+00456' });
    assert.deepEqual(result.calls, ['observe']);
    assert.ok(result.error.includes('取不到') && result.error.includes('选中2行'));
    writeFileSync(join(f.framework, 'lib/test_xlsx.py'), FRAMEWORK + '\nCHANGED = True\n');
    const changed = python(FLOW, { framework: f.framework, contract: f.exported, workbook: file, output: 'sample+public+00123' });
    assert.deepEqual(changed.calls, []);
    assert.ok(changed.error.includes('实际加载文件与执行器规则不一致'));
  } finally { f.close(); }
});

test('the new MCP submission reaches private files and pin while the original submission and polling retain their protocol', () => {
  const f = fixture();
  try {
    const fake = join(f.root, 'fake_gateway.py');
    writeFileSync(fake, `import hashlib,json,types
from pathlib import Path
PINNED_CONTRACT_SHA256='old-pin'
EXECUTION_HEADERS=tuple('ABCDEFGHI')
EXECUTION_SHEET_MARKER='SYNTHETIC_EXECUTION'
CONTRACT_MARKER='SYNTHETIC_CONTRACT'
RUNTIME_SCHEMA='synthetic-runtime@1'
class ExcelContractError(ValueError): pass
def resolve_execution_sheet(value,allow_legacy=False):
    if not isinstance(value,dict):
        sheet=value.worksheets[0];rows=list(sheet.iter_rows(min_col=1,max_col=9,values_only=True))
        if rows[0][2]!=PINNED_CONTRACT_SHA256:raise ExcelContractError('synthetic identity mismatch')
        return sheet,types.SimpleNamespace(header_row=2)
    assert value['pin']==PINNED_CONTRACT_SHA256,'wrong pin'
    return value
def freeze(value): return resolve_execution_sheet(value)
gates=types.SimpleNamespace(resolve_execution_sheet=resolve_execution_sheet,freeze=freeze)
class Framework:
    def stage_case(self,cfg,module,autoid,data,expected_sha256,task_id=None):
        directory=cfg.staging_parent/task_id;directory.mkdir()
        (directory/'case.xlsx').write_text(json.dumps(data))
        (directory/'test_xlsx.py').write_text('LEGACY ENTRY')
        (directory/'excel_contract.json').write_text('LEGACY RULE')
        return {'staging_dir':str(directory),'sha256':expected_sha256}
    def launch_run(self,cfg,task_id,module,autoid,build,fd):
        cfg.trace.append({'task':task_id,'fd':fd,'build':build})
        directory=cfg.staging_parent/task_id
        if (directory/'cell-runtime.json').exists():
            from cell_runtime import load_module
            entry=load_module('synthetic_private_entry',directory/'test_xlsx.py')
            class Device:
                def configure(self,line):
                    cfg.commands.append(line)
                    return cfg.output if line=='observe' else line
            cfg.result=entry.test_xlsx(types.SimpleNamespace(),lambda *args:Device(),None,None,None,None,str(directory/'case.xlsx'))
framework=Framework()
class Gateway:
    def __init__(self,cfg):
        self.cfg=cfg;self.state=object();self.handlers={'case_submit':self.case_submit}
    def audit(self,event,**fields):
        self.cfg.route_audit.append({'event':event,**fields});return True
    def case_submit(self,caller,args):
        frozen=gates.freeze(args['data'])
        stage=framework.stage_case(self.cfg,'synthetic','case',frozen,'synthetic-sha',args['task'])
        framework.launch_run(self.cfg,args['task'],'synthetic','case','synthetic-build',7)
        return {'ok':True,'task_id':args['task'],**stage}
    def call(self,caller,name,args):
        self.cfg.audit.append({'tool':name,'args':args})
        if name=='case_status': return {'task_id':args['task_id'],'state':'done'}
        return self.handlers[name](caller,args)
`);
    const service = join(f.root, 'fake_service.py');
    writeFileSync(service, `TOOL_SPECS=[{'name':'case_submit','scope':'jumphost:run','read_only':False,'description':'synthetic','input_schema':{'type':'object'}}]
def handle_rpc(gateway,caller,message):
    if message['method']=='tools/list': return [item['name'] for item in TOOL_SPECS]
    return gateway.call(caller,message['name'],message['arguments'])
`);
    const caseFile = workbook(f);
    const data = JSON.parse(readFileSync(caseFile, 'utf8'));
    const result = python(`from cell_runtime import load_module
from cell_gateway import Gateway,private_gateway
from cell_gateway import service_namespace
from types import SimpleNamespace
from pathlib import Path
p=json.load(sys.stdin);module=load_module('synthetic_gateway',p['fake'])
cfg=SimpleNamespace(apv_src=Path(p['framework']),staging_parent=Path(p['root']),trace=[],commands=[],audit=[],route_audit=[],output='sample+private+00888\\nsample+public+00123')
base=module.Gateway(cfg);private=private_gateway(base,module.framework,module.gates,p['contract']);router=Gateway(base,private)
service=load_module('synthetic_service',p['service']);namespace=service_namespace(service);rpc=namespace['handle_rpc']
caller=SimpleNamespace(subject='synthetic')
new=rpc(router,caller,{'method':'tools/call','name':'case_submit_cell','arguments':{'task':'new','data':{**p['data'],'pin':p['pin']}}})
route_audit_after_new=list(cfg.route_audit)
old=router.call(caller,'case_submit',{'task':'old','data':{'pin':'old-pin'}})
poll=router.call(caller,'case_status',{'task_id':'new'})
def unknown(target):
    try: target.call(caller,'synthetic-missing',{'same':'arguments'})
    except Exception as error: return {'type':type(error).__name__,'args':error.args}
old_unknown=unknown(base);wrapped_unknown=unknown(router)
directory=Path(new['staging_dir'])
print(json.dumps({'new_entry':(directory/'test_xlsx.py').read_text(),'new_rule':json.loads((directory/'excel_contract.json').read_text())['contract_sha256'],'config':json.loads((directory/'cell-runtime.json').read_text()),'route_audit':cfg.route_audit,'route_audit_after_new':route_audit_after_new,'old_marker_exists':(Path(old['staging_dir'])/'cell-runtime.json').exists(),'old_entry':(Path(old['staging_dir'])/'test_xlsx.py').read_text(),'old_pin':module.PINNED_CONTRACT_SHA256,'poll':poll,'trace':cfg.trace,'same_state':private.state is base.state,'commands':cfg.commands,'selected':cfg.result['registers']['picked'],'tools':rpc(router,None,{'method':'tools/list'}),'old_tools':service.handle_rpc(router,None,{'method':'tools/list'}),'new_specs':namespace['TOOL_SPECS'],'old_specs':service.TOOL_SPECS,'old_unknown':old_unknown,'wrapped_unknown':wrapped_unknown,'audit':cfg.audit}))
`, { fake, service, data, framework: f.framework, root: f.root, contract: f.exported, pin: interfaceDigest(f.document) });
    assert.equal(result.new_entry, readFileSync(join(COMPONENT, 'test_xlsx.py'), 'utf8'));
    assert.equal(result.new_rule, f.document.contract_sha256);
    assert.equal(result.old_entry, 'LEGACY ENTRY');
    assert.equal(result.old_pin, 'old-pin');
    assert.equal(result.same_state, true);
    assert.deepEqual(result.poll, { task_id: 'new', state: 'done' });
    assert.deepEqual(result.trace, [{ task: 'new', fd: 7, build: 'synthetic-build' }, { task: 'old', fd: 7, build: 'synthetic-build' }]);
    assert.equal(result.config.framework_root, f.framework);
    assert.equal(result.config.submission_tool, 'case_submit_cell');
    assert.equal(result.old_marker_exists, false);
    assert.deepEqual(result.route_audit, [
      {event:'cell_route_requested',tool:'case_submit_cell',subject:'synthetic'},
      {event:'cell_route_task',tool:'case_submit_cell',task_id:'new'},
      {event:'cell_route_result',tool:'case_submit_cell',subject:'synthetic',task_id:'new',response_ok:true,replayed:null},
    ]);
    assert.deepEqual(result.route_audit, result.route_audit_after_new, 'old submit, polling and unknown delegation add no private route events');
    assert.deepEqual(result.commands, ['observe', 'use 00123']);
    assert.equal(result.selected, '00123');
    assert.deepEqual(result.tools, ['case_submit', 'case_submit_cell']);
    assert.deepEqual(result.old_tools, ['case_submit']);
    assert.deepEqual(result.new_specs.slice(0,result.old_specs.length),result.old_specs);
    assert.equal(result.new_specs[1].scope,result.old_specs[0].scope);
    assert.equal(result.new_specs[1].read_only,result.old_specs[0].read_only);
    assert.deepEqual(result.new_specs[1].input_schema,result.old_specs[0].input_schema);
    assert.deepEqual(result.wrapped_unknown,result.old_unknown);
    assert.deepEqual(result.audit.map((row: {tool:string})=>row.tool),['case_submit','case_submit','case_status','synthetic-missing','synthetic-missing']);
    assert.deepEqual(result.audit[3],result.audit[4]);
  } finally { f.close(); }
});


test('the declared cell value policy accepts safe ASCII and rejects unsafe character classes and length', () => {
  const result = python(`from table_cell import checked_cell_value,CellSelectionError,CELL_VALUE_POLICY
p=json.load(sys.stdin);accepted=[];refused=[]
for value in p['safe']:
    accepted.append(checked_cell_value(value,CELL_VALUE_POLICY))
for value in p['unsafe']:
    try: checked_cell_value(value,CELL_VALUE_POLICY);refused.append(None)
    except CellSelectionError as error: refused.append(str(error))
print(json.dumps({'accepted':accepted,'refused':refused}))
`, {safe:['00123','Kzone.example.+900+00123+ksk+DEMO+2048','part:rest','x'.repeat(255)],unsafe:['',' ','a b','\n','\r','\t','\x00','\x1f','\x7f','"',"'",';','|','\\','非ASCII','x'.repeat(256)]});
  assert.deepEqual(result.accepted,['00123','Kzone.example.+900+00123+ksk+DEMO+2048','part:rest','x'.repeat(255)]);
  assert.equal(result.refused.length,16);
  for (const error of result.refused) assert.match(error,/取不到.*位置/);
  assert.match(result.refused[0],/长度/);assert.match(result.refused[2],/空白字符/);
  assert.match(result.refused[3],/控制字符/);assert.match(result.refused[9],/引号字符/);
  assert.match(result.refused[11],/非允许符号/);assert.match(result.refused[14],/非ASCII字符/);assert.match(result.refused[15],/长度/);
});

test('runtime rejects unsafe selected cells before the subsequent command without changing the raw observation', () => {
  const f=fixture();
  try {
    const file=workbook(f);
    for (const value of [' ','a b','\n','\r','\t','\x00','\x1f','\x7f','"',"'",';','|','\\','非ASCII','x'.repeat(256)]) {
      const result=python(FLOW,{framework:f.framework,contract:f.exported,workbook:file,output:'sample+public+'+value});
      assert.deepEqual(result.calls,['observe'], JSON.stringify({value,result}));
      assert.match(result.error,/取不到/);
    }
  } finally {f.close();}
});

test('rehashed rule policy injection still fails against the source-verified component declaration', () => {
  const f=fixture();
  try {
    const file=workbook(f);
    for (const mutation of ['characters','length','missing','source']) {
      const document=structuredClone(f.document);
      const cell=document.entries.find((row:{f:string})=>row.f==='table_cell');
      if(mutation==='characters')cell.cell_effect.value_policy.characters+=';|"\\';
      if(mutation==='length')cell.cell_effect.value_policy.max_length=4096;
      if(mutation==='missing')delete cell.cell_effect.value_policy;
      if(mutation==='source')delete document.source_hashes['cell-runtime/table_cell.py'];
      const {contract_sha256:_old,...body}=document;document.contract_sha256=sha(canonical(body));
      const policyFile=join(f.root,'tampered-policy.json');writeFileSync(policyFile,JSON.stringify(document));
      const result=python(FLOW,{framework:f.framework,contract:policyFile,workbook:file,output:'sample+public+00123'});
      assert.deepEqual(result.calls,[]);
      assert.match(result.error,/策略|完整来源摘要/);
    }
  } finally {f.close();}
});
