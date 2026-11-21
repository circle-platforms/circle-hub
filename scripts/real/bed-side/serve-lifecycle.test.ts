import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const component=dirname(fileURLToPath(import.meta.url));
const program=String.raw`
import contextlib,io,json,runpy,sys,types,tempfile,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import cell_gateway
import cell_runtime
scratch=tempfile.TemporaryDirectory(prefix='synthetic-cell-state-')
cell_gateway.COMPONENT_ROOT=Path(scratch.name)
mode=json.load(sys.stdin)['mode']
events=[]
package=types.ModuleType('gateway');package.__path__=[]
sys.modules['gateway']=package
for name in ('tools','framework','gates','service','config','state'):
    module=types.ModuleType('gateway.'+name)
    sys.modules['gateway.'+name]=module
    setattr(package,name,module)
class ConfigError(Exception): pass
class JournalError(Exception): pass
package.config.ConfigError=ConfigError
package.state.JournalError=JournalError
cfg=types.SimpleNamespace(host='192.0.2.1',port=1234,tls_cert=(mode=='tls'))
queue=[{'event':'received'},{'event':'started'}]
audit=[]
class Original:
    def __init__(self): self.cfg=cfg
    def flush_request_audit(self):
        events.append('flush')
        if mode=='audit_failure': raise RuntimeError('synthetic audit unavailable')
        audit.extend(queue);queue.clear()
    def audit(self,event,**fields):
        if mode in ('startup_audit_failure','audit_and_state_unwritable'):raise OSError('synthetic audit unavailable')
        audit.append({'event':event,**fields});return True
    def call(self,caller,name,args):return {'legacy_tool':name,'arguments':args}
def load_gateway(path):
    assert isinstance(path,Path)
    events.append('load')
    if mode=='config_error': raise ConfigError('synthetic config problem')
    if mode=='journal_error': raise JournalError('synthetic journal problem')
    return Original()
package.tools.load_gateway=load_gateway
def private_gateway(original,framework,gates,contract):
    events.append('private')
    if mode in ('missing_rule','source_mismatch','framework_path'):
        root=Path(scratch.name)/'framework';(root/'lib').mkdir(parents=True)
        (root/'lib/test_xlsx.py').write_text('synthetic framework')
        sources={'lib/test_xlsx.py':'b'*64}
        for name in cell_runtime.COMPONENT_FILES:
            sources['cell-runtime/'+name]=hashlib.sha256((cell_runtime.COMPONENT_ROOT/name).read_bytes()).hexdigest()
        document={'schema':'ist.excel.function-contract','complete':True,'entries':[],
          'runtime':{'runner_source':'cell-runtime/test_xlsx.py','runner_sha256':sources['cell-runtime/test_xlsx.py']},
          'source_hashes':sources}
        document['contract_sha256']=cell_runtime.contract_digest(document)
        target=Path(scratch.name)/'contract.json'
        if mode!='missing_rule':target.write_text(json.dumps(document))
        return cell_runtime.read_contract(target,root/'absent' if mode=='framework_path' else root)
    return object()
cell_gateway.private_gateway=private_gateway
if mode in ('state_unwritable','audit_and_state_unwritable'):
    def unwritable(*args):raise PermissionError('synthetic state directory is not writable')
    cell_gateway.component_state=unwritable
class Server:
    def serve_forever(self):
        events.append('serve')
        if mode=='interrupt': raise KeyboardInterrupt()
    def server_close(self): events.append('close')
def build_server(gateway):
    events.append('build')
    assert gateway.cfg is cfg
    if isinstance(gateway,Original):listed[:]=[item['name'] for item in package.service.TOOL_SPECS]
    if mode in ('missing_rule','source_mismatch','framework_path','state_unwritable','startup_audit_failure','audit_and_state_unwritable'):
        assert isinstance(gateway,Original)
        for spec in package.service.TOOL_SPECS:
            assert gateway.call(None,spec['name'],{})=={'legacy_tool':spec['name'],'arguments':{}}
    return Server()
package.service.build_server=build_server
# This unfiltered source/fixture table includes all original tools; authenticated tools/list is scope-filtered.
# Compare the same caller's before/after list in deployment; admin-scoped tools need not be visible there.
package.service.TOOL_SPECS=[{'name':'case_submit','scope':'jumphost:run','read_only':False,'input_schema':{'type':'object'}}]
package.service.TOOL_SPECS += [{'name':'legacy_read_'+str(i),'scope':'jumphost:run','read_only':True,'input_schema':{'type':'object'}} for i in range(12)]
listed=[item['name'] for item in package.service.TOOL_SPECS]
namespace=cell_gateway.service_namespace
def capture_namespace(service):
    result=namespace(service);listed[:]=[item['name'] for item in result['TOOL_SPECS']];return result
cell_gateway.service_namespace=capture_namespace
stderr=io.StringIO()
status=None;error=None
with contextlib.redirect_stderr(stderr):
    try:
        if mode=='entry_exit':
            cell_gateway.serve=lambda *args:2
            sys.argv=['entry.py','serve','--gateway-root','synthetic-gateway','--config','synthetic-config','--contract','synthetic-contract']
            try: runpy.run_path(str(Path(__file__).parent/'entry.py'),run_name='__main__')
            except SystemExit as exc: status=exc.code
        else:
            status=cell_gateway.serve('synthetic-gateway','synthetic-config','synthetic-contract')
    except BaseException as exc: error=type(exc).__name__+': '+str(exc)
state_file=cell_gateway.COMPONENT_ROOT/'runtime/status.json'
print(json.dumps({'status':status,'error':error,'events':events,'stderr':stderr.getvalue(),'queue':queue,'audit':audit,'tools':listed,'component_state':json.loads(state_file.read_text()) if state_file.exists() else None}))
`;
function scenario(mode:string) {
  // A synthetic module graph only; no original gateway, config, credentials, framework, listener or device is loaded.
  const source=program.replace("Path(__file__).parent","Path(sys.path[0])");
  const result=spawnSync('python3',['-c',source,component],{input:JSON.stringify({mode}),encoding:'utf8',env:{PATH:process.env.PATH??'',PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stderr||String(result.error));
  return JSON.parse(result.stdout);
}

test('serve flushes pending request audit before constructing and serving, prints the original listening message and closes',()=>{
  for(const mode of ['normal','tls']) {
    const r=scenario(mode);
    assert.equal(r.error,null);
    assert.deepEqual(r.events,['load','flush','private','build','serve','close']);
    assert.equal(r.status,0);
    assert.deepEqual(r.audit,[{event:'received'},{event:'started'},{event:'cell_component_state',mode:'cell',reason:null}]);
    assert.deepEqual(r.queue,[]);
    assert.equal(r.stderr,'cexg 监听 '+(mode==='tls'?'https':'http')+'://192.0.2.1:1234/mcp\n');
  }
});

test('cell status or component-audit write failure does not take down the original service',()=>{
  for(const mode of ['state_unwritable','startup_audit_failure','audit_and_state_unwritable']) {
    const r=scenario(mode);
    assert.equal(r.status,0);assert.equal(r.error,null);assert.equal(r.tools.length,13);
    assert.equal(r.tools.includes('case_submit_cell'),false);
    assert.match(r.stderr,/仅提供原工具/);
    if(mode!=='startup_audit_failure')assert.equal(r.component_state,null);
    else {assert.equal(r.component_state.mode,'original');assert.match(r.component_state.reason,/audit unavailable/);}
  }
});

test('missing cell rules, mismatched sources and an invalid framework path leave every original tool available',()=>{
  for(const mode of ['missing_rule','source_mismatch','framework_path']) {
    const r=scenario(mode);
    assert.equal(r.error,null);
    assert.equal(r.status,0);
    assert.equal(r.tools.length,13);
    assert.equal(r.tools.includes('case_submit_cell'),false);
    assert.equal(r.component_state.schema,'value-pick-state@1');
    assert.equal(r.component_state.mode,'original');
    assert.equal(typeof r.component_state.recorded_at,'string');
    assert.ok(r.component_state.reason.length>0);
    if(mode==='source_mismatch')assert.match(r.component_state.reason,/实际加载文件与执行器规则不一致/);
    else assert.match(r.component_state.reason,/FileNotFoundError/);
    assert.match(r.stderr,/取值组件未启用，仅提供原工具/);
    assert.equal(r.audit.filter((row:{event:string})=>row.event==='cell_component_state').length,1);
    assert.equal(r.audit.at(-1).mode,'original');
    assert.equal(r.events.at(-1),'close');
  }
});

test('configuration and journal startup errors preserve the original error category and exit two without serving',()=>{
  for(const [mode,message]of [['config_error','配置错误：synthetic config problem\n'],['journal_error','请求日志错误：synthetic journal problem\n']]) {
    const r=scenario(mode);
    assert.equal(r.error,null);
    assert.equal(r.status,2);
    assert.deepEqual(r.events,['load']);
    assert.equal(r.stderr,message);
    assert.deepEqual(r.audit,[]);
  }
});

test('KeyboardInterrupt closes the server and returns zero; audit failure stays a startup failure instead of being hidden',()=>{
  const stopped=scenario('interrupt');
  assert.equal(stopped.error,null);
  assert.equal(stopped.status,0);
  assert.equal(stopped.events.at(-1),'close');
  const failed=scenario('audit_failure');
  assert.match(failed.error,/RuntimeError: synthetic audit unavailable/);
  assert.deepEqual(failed.events,['load','flush']);
  assert.deepEqual(failed.audit,[]);
  assert.equal(failed.stderr,'');
});

test('the real entry main guard propagates serve exit two',()=>{
  const r=scenario('entry_exit');
  assert.equal(r.error,null);
  assert.equal(r.status,2);
});
