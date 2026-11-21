// Synthetic Python module graph and in-memory workbook only; no vendor, framework, database or listener.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const component = dirname(fileURLToPath(import.meta.url));
const program = String.raw`
import contextlib,io,json,sys,types
sys.path.insert(0,sys.argv[1])
import cell_gateway,cell_runtime
mode=json.load(sys.stdin)['mode']
old_pin,new_pin='a'*64,'b'*64
gates=types.ModuleType('synthetic_pin_gates')
exec('''
import types
PINNED_CONTRACT_SHA256='a'*64
EXECUTION_HEADERS=tuple('ABCDEFGHI')
EXECUTION_SHEET_MARKER='SYNTHETIC_EXECUTION_SHEET'
CONTRACT_MARKER='SYNTHETIC_CONTRACT'
RUNTIME_SCHEMA='synthetic-runtime@1'
calls=[]
class ExcelContractError(ValueError): pass
def helper_pin(): return PINNED_CONTRACT_SHA256
def resolve_execution_sheet(workbook,*,allow_legacy=False):
    assert allow_legacy is False
    sheet=workbook.worksheets[0]
    rows=list(sheet.iter_rows(min_col=1,max_col=9,values_only=True))
    assert rows[1]==EXECUTION_HEADERS
    assert list(workbook.defined_names[EXECUTION_SHEET_MARKER].destinations)==[(sheet.title,'$A$2:$I$2')]
    assert rows[0][:2]==(CONTRACT_MARKER,RUNTIME_SCHEMA)
    pin=rows[0][2]
    calls.append(pin)
    expected=helper_pin() if MODE=='helper' else PINNED_CONTRACT_SHA256
    if MODE=='reject_all' or (MODE!='accept_all' and pin!=expected):
        if MODE=='wrong_error': raise RuntimeError('synthetic unexpected failure')
        raise ExcelContractError('synthetic identity mismatch')
    return sheet,types.SimpleNamespace(header_row=2)
def freeze(workbook): return resolve_execution_sheet(workbook,allow_legacy=False)
''',gates.__dict__)
gates.MODE=mode
original_globals=dict(gates.__dict__)
private_globals=dict(gates.__dict__);private_globals['PINNED_CONTRACT_SHA256']=new_pin
private_resolver=cell_runtime.copy_function(gates.resolve_execution_sheet,private_globals)
result={'passed':False,'failure':None}
try: cell_gateway.check_private_pin(gates.resolve_execution_sheet,private_resolver,new_pin);result['passed']=True
except Exception as error: result['failure']=type(error).__name__
assert set(gates.__dict__)==set(original_globals)
assert all(gates.__dict__[key] is value for key,value in original_globals.items())
assert gates.PINNED_CONTRACT_SHA256==old_pin
result['calls']=list(gates.calls)
if mode in ('direct','helper'):
    # Exercise the actual private construction and the existing serve fallback, not a second self-check implementation.
    cell_runtime.read_contract=lambda *args:{'contract_sha256':'c'*64}
    cell_runtime.interface_digest=lambda document:new_pin
    class Original:
        def __init__(self):
            self.cfg=types.SimpleNamespace(apv_src='synthetic-framework',tls_cert=None,host='192.0.2.1',port=1234)
            self.handlers={'case_submit':self.case_submit}
        def case_submit(self,caller,args):return {'ok':True}
        def flush_request_audit(self):pass
        def audit(self,*args,**kwargs):return True
    original=Original()
    try:
        private=cell_gateway.private_gateway(original,types.SimpleNamespace(),gates,'synthetic-contract')
        assert private.handlers is not original.handlers
        result['constructed']=True
    except Exception:result['constructed']=False
    package=types.ModuleType('gateway');package.__path__=[];sys.modules['gateway']=package
    for name in ('tools','framework','gates','service','config','state'):
        module=gates if name=='gates' else types.ModuleType('gateway.'+name)
        sys.modules['gateway.'+name]=module;setattr(package,name,module)
    package.tools.load_gateway=lambda path:original
    package.config.ConfigError=type('ConfigError',(Exception,),{})
    package.state.JournalError=type('JournalError',(Exception,),{})
    package.service.TOOL_SPECS=[{'name':'case_submit'}]
    events=[]
    class Server:
        def serve_forever(self):events.append('serve')
        def server_close(self):events.append('close')
    def build_server(active):
        events.append('original' if active is original else 'private')
        return Server()
    package.service.build_server=build_server
    cell_gateway.component_state=lambda mode,reason:events.append(mode)
    with contextlib.redirect_stderr(io.StringIO()):
        assert cell_gateway.serve('synthetic-gateway','synthetic-config','synthetic-contract')==0
    result['events']=events
    assert gates.PINNED_CONTRACT_SHA256==old_pin
    assert gates.resolve_execution_sheet is original_globals['resolve_execution_sheet']
print(json.dumps(result))
`;

function scenario(mode: string) {
  const child = spawnSync('python3', ['-c', program, component], {
    input: JSON.stringify({ mode }), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}

test('private resolver accepts the new pin, rejects the old, and leaves original globals and original pin behavior intact', () => {
  const result = scenario('direct');
  assert.equal(result.passed, true);
  assert.deepEqual(result.calls.slice(0, 4), ['b'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(result.constructed, true);
  assert.deepEqual(result.events, ['cell', 'private', 'serve', 'close']);
});

test('a helper reading its original globals defeats the override and the real serve falls back to the original gateway', () => {
  const result = scenario('helper');
  assert.equal(result.passed, false);
  assert.equal(result.constructed, false);
  assert.deepEqual(result.events, ['original', 'original', 'serve', 'close']);
});

for (const mode of ['accept_all', 'reject_all', 'wrong_error']) {
  test(`pin self-check rejects ${mode} resolver behavior instead of treating it as an identity proof`, () => {
    assert.equal(scenario(mode).passed, false);
  });
}
