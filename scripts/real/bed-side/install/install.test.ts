// Synthetic process and filesystem ports only. Never invoke the host systemctl, gateway, network or device code.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
const source = fileURLToPath(new URL('./installer.py', import.meta.url));
const fixture = String.raw`
import importlib.util,json,os,pwd,sys,tempfile,shutil
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('synthetic_installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Fixture:
 def __init__(self,fail=None):
  self.root=Path(tempfile.mkdtemp(prefix='synthetic-cell-install-'));self.fail=fail;self.failed=False;self.calls=[];self.requests=[];self.now=0;self.sleeps=0;self.active='active';self.sub='running';self.loaded=[];self.chowns=[]
  self.unit='synthetic.service';self.gateway=self.root/'release/gateway-source';self.gateway.mkdir(parents=True)
  self.framework=self.root/'framework';(self.framework/'lib').mkdir(parents=True)
  (self.framework/'lib/excel_contract.json').write_text(json.dumps({'objects':[{'e':'SYNTHETIC','status':'enabled'}]}))
  self.config=self.root/'gateway.toml';self.config.write_text('[framework]\napv_src = "'+str(self.framework)+'"\npy38 = "'+sys.executable+'"\n')
  self.fragment=self.root/'units'/self.unit;self.fragment.parent.mkdir();self.fragment.write_text('ORIGINAL UNIT BYTES')
  self.parent=self.fragment.parent/(self.unit+'.d');self.drop=self.parent/'zz-value-pick-synthetic.conf'
  self.original=[sys.executable,'-m','gateway.cexg','serve','--config',str(self.config)];self.effective=list(self.original)
  self.bundle=self.root/'bundle';(self.bundle/'bed-side').mkdir(parents=True);(self.bundle/'install').mkdir()
  for name in m.FILES:(self.bundle/'bed-side'/name).write_text('# synthetic code, not executed\n')
  (self.bundle/'install/observe.py').write_text('# synthetic observer, injected not executed\n')
  (self.bundle/'base-hub-contract.json').write_text('{}')
  self.plan={'release':'synthetic','source_commit':'a'*40,'component_sha256':{n:m.sha(self.bundle/'bed-side'/n) for n in m.FILES},'checker_sha256':m.sha(self.bundle/'install/observe.py'),'base_hub_sha256':m.sha(self.bundle/'base-hub-contract.json'),'installer_sha256':m.sha(Path(sys.argv[1])),'objects':['SYNTHETIC'],'missing_requirements':[]}
  self.write_plan()
  self.version=self.gateway.parent/'cell-runtime-releases/synthetic'
  self.engine=m.Installer(systemctl=str(self.root/'fake-systemctl'),runner=self.run,clock=lambda:self.now,sleep=self.sleep,timeout=.5)
  self.patcher=patch.object(m.os,'chown',side_effect=lambda *args:self.chowns.append(args));self.patcher.start()
 def write_plan(self):(self.bundle/'install-plan.json').write_text(json.dumps(self.plan))
 def sleep(self,n):self.sleeps+=1;self.now+=n
 def wrap(self):
  self.parent.mkdir(exist_ok=True)
  self.effective=[sys.executable,str(self.version/'entry.py'),'serve','--gateway-root',str(self.gateway),'--config',str(self.config),'--contract',str(self.version/'excel-contract.json')]
  self.drop.write_text(m.dropin_text(self.effective));self.loaded=[self.drop];self.version.mkdir(parents=True,exist_ok=True);(self.version/'keep').write_text('retained')
 def facts(self,request):
  tools=['case_submit','lease_status']+(['case_submit_cell'] if request['phase']=='postcheck' else [])
  return {'schema':'value-pick-observation@1','verified':True,'jobs':0,'leased':False,'bed_busy':False,'version':'0.4.7','tools':tools,'task_inventory_sha256':'b'*64,'request_records_sha256':'c'*64}
 def run(self,argv,timeout=30,input=None):
  self.calls.append((list(argv),timeout))
  if argv[0]==self.engine.systemctl:
   if argv[1]=='show':
    key=argv[3].split('=',1)[1]
    values={'ExecStart':'{ path='+self.effective[0]+' ; argv[]='+' '.join(self.effective)+' ; ignore_errors=no ; pid=1 ; }','WorkingDirectory':str(self.gateway),'FragmentPath':str(self.fragment),'DropInPaths':' '.join(str(p) for p in self.loaded),'ActiveState':self.active,'SubState':self.sub,'User':pwd.getpwuid(os.getuid()).pw_name,'DynamicUser':'no'}
    return values[key]
   if argv[1]=='daemon-reload':
    if self.fail=='reload' and self.drop.exists() and not self.failed:self.failed=True;raise m.InstallFailure('command','synthetic_reload_failure')
    self.loaded=[self.drop] if self.drop.exists() else []
    self.effective=self.drop.read_text().split('ExecStart=')[-1].strip().split() if self.drop.exists() else list(self.original)
    return ''
   if argv[1]=='restart':
    if self.fail=='restart' and self.drop.exists() and not self.failed:self.failed=True;self.active='failed';self.sub='failed';raise m.InstallFailure('command','synthetic_restart_failure')
    if self.fail=='rollback_restart' and not self.drop.exists():self.active='failed';self.sub='failed';raise m.InstallFailure('command','synthetic_rollback_restart_failure')
    self.active='failed' if self.fail=='timeout' and self.drop.exists() else 'active';self.sub='failed' if self.active=='failed' else 'running';return ''
   raise AssertionError('unknown fake systemctl operation')
  if len(argv)>1 and argv[1]==str(self.bundle/'install/observe.py'):
   assert argv[0]==sys.executable
   request=json.loads(input);self.requests.append(request);facts=self.facts(request)
   if self.fail=='postcheck' and request['phase']=='postcheck':facts['tools']=['case_submit_cell']
   if self.fail=='unknown':facts['jobs']=None;facts['verified']=False
   return json.dumps(facts)
  if 'export-contract' in argv or 'export-hub-contract' in argv:
   Path(argv[argv.index('--out')+1]).write_text('{}');return '{}'
  raise AssertionError('unexpected external process')
 def close(self):self.patcher.stop();shutil.rmtree(self.root)
f=Fixture()
try:
`;
function check(body: string) {
  const script = fixture + body.split('\n').map(line => ' '+line).join('\n') + '\nfinally:f.close()\nprint("synthetic checks passed")';
  const result=spawnSync('python3',['-B','-c',script,source],{encoding:'utf8',env:{PATH:process.env.PATH ?? '/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr || result.stdout);
  assert.match(result.stdout,/synthetic checks passed/);
}

test('preflight is read-only, proves fixed bytes and calls the 0600 observer through Python',()=>check(`
before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
state=f.engine.preflight(f.bundle,f.unit)
after={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
assert before==after and state['facts']['jobs']==0
assert f.requests and all(r['phase']=='preflight' for r in f.requests)
assert not any(a[1] in ['restart','daemon-reload'] for a,t in f.calls)
assert m.Installer().timeout==30
`));

test('install preserves original unit, uses grouped observation phases and produces service-readable new files under umask077',()=>check(`
old=os.umask(0o077)
try:answer=f.engine.install(f.bundle,f.unit)
finally:os.umask(old)
assert answer['ok'] and f.fragment.read_text()=='ORIGINAL UNIT BYTES'
assert f.version.stat().st_mode&0o777==0o755 and f.version.parent.stat().st_mode&0o777==0o755
for name in m.FILES:assert (f.version/name).stat().st_mode&0o777==0o644
for name in ['excel-contract.json','hub-contract.json']:assert (f.version/name).stat().st_mode&0o777==0o600
assert len(f.chowns)==2
assert any(r['phase']=='postcheck' and r['component_root']==str(f.version) for r in f.requests)
assert f.drop.read_text()==m.dropin_text(f.effective)
`));

test('rollback works with failed service and missing PLAN/checker/config, retaining all referenced version files',()=>check(`
f.wrap();f.active='failed';f.sub='failed'
(f.bundle/'install-plan.json').unlink();(f.bundle/'install/observe.py').unlink();f.config.unlink()
answer=f.engine.rollback(f.unit)
assert answer['ok'] and answer['removed'] and answer['restored'] and not f.drop.exists()
assert (f.version/'keep').read_text()=='retained'
assert f.requests==[] and f.effective==f.original
assert answer['before']=={'active':'failed','sub':'failed'}
assert answer['idle_checked'] is False and answer['observer_required'] is False
f.wrap();original_show=f.engine.show;unread={'ActiveState','SubState'}
def missing_before(unit,property):
 if property in unread:unread.remove(property);raise OSError('synthetic status unreadable')
 return original_show(unit,property)
f.engine.show=missing_before
unknown=f.engine.rollback(f.unit)
assert unknown['ok'] and unknown['before']=={'active':None,'sub':None}
assert unknown['idle_checked'] is False and unknown['observer_required'] is False
assert f.requests==[] and not f.drop.exists()
`));

test('reload failure with original ExecStart and empty loaded DropInPaths automatically removes the unpublished configuration',()=>check(`
f.fail='reload'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:
 assert e.stage=='reload' and e.rollback['ok'] and e.rollback['removed'] and e.rollback['restored']
assert f.failed and not f.drop.exists() and f.effective==f.original
assert not list(f.parent.glob('.value-pick-*'))
`));

test('restart command failure automatically restores original entry and reports original stage',()=>check(`
f.fail='restart'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:
 assert e.stage=='restart' and e.rollback['ok'] and e.rollback['restored']
 assert str(f.root) not in json.dumps(e.report())
assert not f.drop.exists() and f.effective==f.original
`));

test('bounded startup wait uses an injected clock and automatically rolls back without wall-clock assertions',()=>check(`
f.fail='timeout'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:assert e.reason=='service_timeout' and e.rollback['ok']
assert f.sleeps>0 and all(t==.5 for a,t in f.calls)
assert not f.drop.exists()
`));

test('postcheck mismatch automatically rolls back while preserving actual original tools and task/request evidence',()=>check(`
f.fail='postcheck'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:assert e.stage=='postcheck' and e.rollback['ok']
assert not f.drop.exists() and f.effective==f.original
`));

test('rollback reports deletion and restoration separately when restoring restart itself fails',()=>check(`
f.wrap();f.fail='rollback_restart'
answer=f.engine.rollback(f.unit)
assert not answer['ok'] and answer['removed'] is True and answer['restored'] is False
assert answer['stage']=='rollback_restart' and not f.drop.exists()
`));

test('tampered or ambiguous drop-ins are refused without deleting another configuration',()=>check(`
f.wrap();original=f.drop.read_text();f.drop.write_text(original+'Environment=SYNTHETIC\\n')
assert not f.engine.rollback(f.unit)['removed'] and f.drop.exists()
f.drop.write_text(original);other=f.parent/'zz-value-pick-other.conf';other.write_text('synthetic unrelated')
f.loaded=[f.drop,other]
assert not f.engine.rollback(f.unit)['removed'] and other.exists() and f.drop.exists()
`));

test('unknown observation and hash mismatch stop before any installation write',()=>check(`
f.fail='unknown'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:assert e.reason=='observation_unknown'
assert not f.version.exists() and not f.parent.exists()
f.fail=None;f.plan['component_sha256']['entry.py']='0'*64;f.write_plan()
try:f.engine.preflight(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:assert e.reason=='component_identity_mismatch'
`));

test('drop-in write failure leaves no partially visible configuration and no temporary file',()=>check(`
original=m.os.fdopen
class Broken:
 def __init__(self,*a,**kw):self.stream=original(*a,**kw)
 def __enter__(self):return self
 def __exit__(self,*a):self.stream.close()
 def write(self,text):raise OSError('synthetic write failure')
with patch.object(m.os,'fdopen',Broken):
 try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
 except m.InstallFailure as e:assert e.stage=='dropin' and e.rollback is None
assert not f.drop.exists() and not list(f.parent.glob('.value-pick-*'))
`));

test('exclusive atomic publication never overwrites a configuration created by another writer',()=>check(`
original=m.os.link
def collision(src,dst):
 Path(dst).write_text('SYNTHETIC OTHER WRITER')
 return original(src,dst)
with patch.object(m.os,'link',collision):
 try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
 except m.InstallFailure as e:assert e.stage=='dropin' and e.rollback is None
assert f.drop.read_text()=='SYNTHETIC OTHER WRITER'
assert not list(f.parent.glob('.value-pick-*')) and f.effective==f.original
`));

test('installer postcheck composes with the real observer against synthetic proc, cgroup and SQLite state',()=>check(String.raw`
import sqlite3
observer_source=Path(sys.argv[1]).with_name('observe.py')
(f.bundle/'install/observe.py').write_bytes(observer_source.read_bytes())
f.plan['checker_sha256']=m.sha(f.bundle/'install/observe.py')
(f.bundle/'bed-side/cell_gateway.py').write_text("SUBMIT_TOOL='case_submit_cell'\nraise RuntimeError('must not import wrapper')\n")
f.plan['component_sha256']['cell_gateway.py']=m.sha(f.bundle/'bed-side/cell_gateway.py');f.write_plan()
(f.gateway/'gateway').mkdir()
(f.gateway/'gateway/service.py').write_text("SERVER_INFO={'version':'0.4.7'}\nraise RuntimeError('must not import gateway')\n")
(f.gateway/'gateway/tools.py').write_text("TOOL_SPECS=[{'name':'case_submit'},{'name':'lease_status'}]\nraise RuntimeError('must not import gateway')\n")
state=f.root/'state';state.mkdir();(state/'tasks').mkdir();(state/'bed.lock').write_text('')
staging=f.root/'staging';staging.mkdir();proc=f.root/'proc';cg=f.root/'cgroup'
f.config.write_text(f.config.read_text()+'staging_parent="'+str(staging)+'"\n[state]\ndir="'+str(state)+'"\n')
(proc/'42').mkdir(parents=True);(proc/'42/cgroup').write_text('0::/synthetic.slice\n')
(proc/'sys/kernel/random').mkdir(parents=True);(proc/'sys/kernel/random/boot_id').write_text('synthetic-boot\n')
(cg/'synthetic.slice').mkdir(parents=True);(cg/'cgroup.controllers').write_text('cpu\n');(cg/'synthetic.slice/cgroup.procs').write_text('42\n')
with sqlite3.connect(state/'state.db') as db:db.executescript('CREATE TABLE lease(bed TEXT,released INTEGER,clock_epoch TEXT,monotonic_deadline REAL);CREATE TABLE tasks(task_id TEXT);')
journal=state.with_name(state.name+'.request-journal');journal.mkdir()
with sqlite3.connect(journal/'requests.db') as db:db.executescript('CREATE TABLE requests(request_id TEXT);CREATE TABLE request_meta(name TEXT,value TEXT);CREATE TABLE request_tombstones(request_id TEXT,not_after REAL);')
spec2=importlib.util.spec_from_file_location('real_synthetic_observer',f.bundle/'install/observe.py');obs=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(obs)
original_run=f.run
seen=[]
def combined(argv,timeout=30,input=None):
 if len(argv)>1 and argv[1]==str(f.bundle/'install/observe.py'):
  request=json.loads(input);seen.append(request)
  def properties(unit):
   return {'MainPID':'42','ControlGroup':'/synthetic.slice','WorkingDirectory':str(f.gateway),'ExecStart':original_run([f.engine.systemctl,'show',unit,'--property=ExecStart','--value'])}
  facts=obs.observe(request,proc_root=proc,cgroup_root=cg,properties=properties)
  return json.dumps(facts)
 return original_run(argv,timeout=timeout,input=input)
f.engine.runner=combined
answer=f.engine.install(f.bundle,f.unit)
assert answer['ok']
post=[r for r in seen if r['phase']=='postcheck'];assert len(post)==1 and post[0]['component_root']==str(f.version)
assert f.drop.exists()
`));
