import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const component=dirname(fileURLToPath(import.meta.url));
const program=String.raw`
import contextlib,io,json,runpy,sys,types
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import cell_gateway
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
def load_gateway(path):
    assert isinstance(path,Path)
    events.append('load')
    if mode=='config_error': raise ConfigError('synthetic config problem')
    if mode=='journal_error': raise JournalError('synthetic journal problem')
    return Original()
package.tools.load_gateway=load_gateway
def private_gateway(original,framework,gates,contract):
    events.append('private')
    return object()
cell_gateway.private_gateway=private_gateway
class Server:
    def serve_forever(self):
        events.append('serve')
        if mode=='interrupt': raise KeyboardInterrupt()
    def server_close(self): events.append('close')
def build_server(gateway):
    events.append('build')
    assert gateway.cfg is cfg
    return Server()
package.service.build_server=build_server
package.service.TOOL_SPECS=[{'name':'case_submit','scope':'jumphost:run','read_only':False,'input_schema':{'type':'object'}}]
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
print(json.dumps({'status':status,'error':error,'events':events,'stderr':stderr.getvalue(),'queue':queue,'audit':audit}))
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
    assert.deepEqual(r.audit,[{event:'received'},{event:'started'}]);
    assert.deepEqual(r.queue,[]);
    assert.equal(r.stderr,'cexg 监听 '+(mode==='tls'?'https':'http')+'://192.0.2.1:1234/mcp\n');
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
