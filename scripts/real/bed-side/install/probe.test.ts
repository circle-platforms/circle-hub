import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const file = fileURLToPath(new URL('./probe.py', import.meta.url));
const driver = String.raw`
import ast,http.server,importlib.util,ipaddress,json,os,socket,ssl,subprocess,sys,tempfile,threading,time
from pathlib import Path
p=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('synthetic_probe',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='synthetic-mcp-probe-') as tmp:
    root=Path(tmp);calls=[];followed=[];servers=[];threads=[]
    class Quiet(http.server.ThreadingHTTPServer):
        daemon_threads=True
        def handle_error(self,*args): pass
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):self.answer()
        def do_POST(self):self.answer()
        def answer(self):
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            calls.append({'method':self.command,'path':self.path,'headers':dict(self.headers),'body':body.decode()})
            mode=p.get('mode','auth')
            if mode=='timeout':time.sleep(.2)
            status=404 if self.command=='GET' else 401
            value={};headers={}
            if mode=='auth403' and self.command=='POST':status=403
            if mode=='redirect':status=302;headers['Location']='http://127.0.0.1:'+str(decoy.server_port)+'/mcp'
            if mode=='missing':status=404
            if mode=='unhealthy':status=503
            if self.command=='POST':
                if mode=='rpc':status=200;value={'jsonrpc':'2.0','id':'value-pick-probe','result':{}}
                if mode=='rpc-error':status=400;value={'jsonrpc':'2.0','id':'value-pick-probe','error':{'code':-32600,'message':'synthetic'}}
                if mode=='wrong-id':status=200;value={'jsonrpc':'2.0','id':'another','result':{}}
                if mode=='html':status=200
                if mode=='dual':status=200;value={'jsonrpc':'2.0','id':'value-pick-probe','result':{},'error':{}}
                if mode=='oversize':status=200;value={'jsonrpc':'2.0','id':'value-pick-probe','result':{'body':'x'*66000}}
            if mode=='get503' and self.command=='GET':status=503
            data=b'<html>synthetic</html>' if mode=='html' else json.dumps(value).encode()
            self.send_response(status);self.send_header('Content-Type','text/html' if mode=='html' else 'application/json');self.send_header('Content-Length',str(len(data)))
            for k,v in headers.items():self.send_header(k,v)
            self.end_headers()
            try:self.wfile.write(data)
            except OSError:pass
    class Decoy(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):followed.append(True);self.send_response(200);self.end_headers()
        do_POST=do_GET
    def serve(server):
        servers.append(server);thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True);thread.start();threads.append(thread);return server
    decoy=serve(Quiet(('127.0.0.1',0),Decoy))
    if p.get('ipv6'):
        class V6(Quiet):address_family=socket.AF_INET6
        server=V6(('::1',0),Handler)
    else:server=Quiet(('127.0.0.1',0),Handler)
    if p.get('tls'):
        key,cert=root/'synthetic-key.pem',root/'synthetic-cert.pem'
        created=subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=synthetic.invalid'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        assert created.returncode==0
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(cert),str(key));server.socket=context.wrap_socket(server.socket,server_side=True)
    serve(server)
    host=p.get('host','::' if p.get('ipv6') else '0.0.0.0')
    config=root/'gateway.toml'
    text='[listen]\nhost="'+host+'"\nport='+str(server.server_port)+'\n'
    if p.get('tls'):text+='tls_cert="SYNTHETIC_DO_NOT_OPEN_CERT"\ntls_key="SYNTHETIC_DO_NOT_OPEN_KEY"\n'
    text+='[hub]\nsecret_sha256_file="SYNTHETIC_DO_NOT_OPEN_CREDENTIAL"\n'
    if 'config' in p:text=p['config'].replace('PORT',str(server.server_port))
    config.write_text(text)
    if p.get('refuse_network'):
        class NoNetwork:
            def __init__(self,*args,**kwargs):raise AssertionError('invalid config attempted a connection')
        m.http.client.HTTPConnection=NoNetwork;m.http.client.HTTPSConnection=NoNetwork
    stub_calls=[]
    if p.get('literal_stub'):
        class StubResponse:
            status=401
        class StubConnection:
            def __init__(self,host,port,timeout,**kwargs):
                assert host==str(ipaddress.ip_address(p['host'])) and port==server.server_port
                stub_calls.append({'host':host,'port':port})
            def request(self,method,path,body=None,headers=None):
                assert method=='POST' and path=='/mcp'
                assert json.loads(body)=={'jsonrpc':'2.0','id':'value-pick-probe','method':'ping','params':{}}
                assert all(key.lower() not in ('authorization','cookie') for key in headers)
            def getresponse(self):return StubResponse()
            def close(self):pass
        m.http.client.HTTPConnection=StubConnection;m.http.client.HTTPSConnection=StubConnection
    if p.get('mode')=='refused':server.shutdown();server.server_close()
    if p.get('missing_config'):config.unlink()
    result=m.probe(str(config),p.get('timeout',1))
    for srv in servers:srv.shutdown();srv.server_close()
    for thread in threads:thread.join()
    ast.parse(Path(sys.argv[1]).read_text(),feature_version=(3,8))
    print(json.dumps({'result':result,'calls':calls,'followed':followed,'stub_calls':stub_calls}))
`;
function check(options: Record<string, unknown> = {}) {
  const child=spawnSync('python3',['-B','-c',driver,file],{input:JSON.stringify(options),encoding:'utf8',env:{PATH:process.env.PATH??'',PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const result=JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(result.result).sort(),['outcome','status']);
  assert.doesNotMatch(JSON.stringify(result.result),/SYNTHETIC|127\.0\.0\.1|::1|gateway\.toml|[\\/]/);
  for (const call of result.calls) {
    assert.equal(call.path,'/mcp');assert.equal(call.method,'POST');
    const headers=Object.keys(call.headers).map(key=>key.toLowerCase());
    assert.equal(headers.includes('authorization'),false);assert.equal(headers.includes('cookie'),false);
    if(call.method==='POST')assert.deepEqual(JSON.parse(call.body),{jsonrpc:'2.0',id:'value-pick-probe',method:'ping',params:{}});
  }
  return result;
}

test('one unauthenticated POST matching the 0.4.7 route proves only an authentication response',()=>{
  const result=check();assert.deepEqual(result.result,{status:'ok',outcome:'authentication_required'});
  assert.deepEqual(result.calls.map((call:{method:string})=>call.method),['POST']);
});
test('403 POST is accepted and an irrelevant GET503 cannot precede the valid POST',()=>{
  assert.equal(check({mode:'auth403'}).result.status,'ok');
  const result=check({mode:'get503'});assert.equal(result.result.status,'ok');
  assert.deepEqual(result.calls.map((call:{method:string})=>call.method),['POST']);
});
test('a bounded matching JSON RPC ping response or explicit RPC error confirms the endpoint is answering',()=>{
  for(const mode of ['rpc','rpc-error'])assert.deepEqual(check({mode}).result,{status:'ok',outcome:'mcp_response_received'});
});
test('redirects are neither followed nor mistaken for MCP liveness',()=>{
  const result=check({mode:'redirect'});assert.deepEqual(result.result,{status:'error',outcome:'redirect_refused'});assert.deepEqual(result.followed,[]);assert.equal(result.calls.length,1);
});
test('404 HTML wrong request identity dual outcomes oversize replies and 503 do not confirm MCP',()=>{
  for(const mode of ['missing','html','wrong-id','dual','oversize','unhealthy'])assert.equal(check({mode}).result.status,'error',mode);
});
test('wildcard IPv4 IPv6 and localhost derive only numeric loopback targets',()=>{
  assert.equal(check({host:'127.0.0.1'}).result.status,'ok');assert.equal(check({host:'localhost'}).result.status,'ok');
  assert.equal(check({ipv6:true}).result.status,'ok');
});
test('explicit literal listener IPv4 and IPv6 reach exactly the configured address through a synthetic connection',()=>{
  for(const host of ['192.0.2.7','2001:db8::7','::ffff:192.0.2.7']) {
    const result=check({host,literal_stub:true});
    assert.deepEqual(result.result,{status:'ok',outcome:'authentication_required'});
    assert.equal(result.stub_calls.length,1);
    assert.equal(typeof result.stub_calls[0].port,'number');
    assert.deepEqual(result.calls,[],'the configured non-loopback address never uses a real connection');
  }
});
test('arbitrary hostnames URLs proxy syntax and credential-bearing addresses are rejected',()=>{
  for(const host of ['example.invalid','http://192.0.2.7:8910/mcp','user@192.0.2.7','192.0.2.7:8910'])
    assert.deepEqual(check({host,refuse_network:true}).result,{status:'error',outcome:'listen_config_unavailable'});
});
test('TLS can answer locally without opening any configured CA private key or credential path',()=>{
  assert.deepEqual(check({tls:true}).result,{status:'ok',outcome:'authentication_required'});
});
test('unreadable duplicate escaped missing listen fields and incomplete TLS config fail closed',()=>{
  const configs=['[listen]\nhost="127.0.0.1"', '[listen]\nhost="127.0.0.1"\nport=PORT\nport=PORT', '[listen]\nhost="local\\host"\nport=PORT', '[listen]\nhost="127.0.0.1"\nport=PORT\ntls_cert="only"', '[listen]\nhost="127.0.0.1"\nport=0'];
  for(const config of configs)assert.equal(check({config,refuse_network:true}).result.status,'error');
  assert.equal(check({missing_config:true,refuse_network:true}).result.status,'error');
});
test('timeouts and connection refusal return bounded non-sensitive failures',()=>{
  assert.deepEqual(check({mode:'timeout',timeout:.03}).result,{status:'error',outcome:'timeout'});
  assert.equal(check({mode:'refused'}).result.status,'error');
  assert.deepEqual(check({timeout:0,refuse_network:true}).result,{status:'error',outcome:'invalid_timeout'});
});
