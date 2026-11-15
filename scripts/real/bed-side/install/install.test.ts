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
import ast
ast.parse(Path(sys.argv[1]).read_text(),feature_version=(3,8))
class Fixture:
 def __init__(self,fail=None):
  self.root=Path(tempfile.mkdtemp(prefix='synthetic-cell-install-'));self.fail=fail;self.failed=False;self.calls=[];self.requests=[];self.now=0;self.sleeps=0;self.pid=42;self.restarts=0;self.on_sleep=None;self.reset_restart_counter=False;self.active='active';self.sub='running';self.loaded=[];self.chowns=[]
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
  (self.bundle/'install/probe.py').write_text('# synthetic probe, injected not executed\n')
  (self.bundle/'base-hub-contract.json').write_text('{}')
  self.plan={'release':'synthetic','source_commit':'a'*40,'component_sha256':{n:m.sha(self.bundle/'bed-side'/n) for n in m.FILES},'checker_sha256':m.sha(self.bundle/'install/observe.py'),'base_hub_sha256':m.sha(self.bundle/'base-hub-contract.json'),'installer_sha256':m.sha(Path(sys.argv[1])),'objects':['SYNTHETIC'],'missing_requirements':[]}
  self.write_plan()
  self.plan['probe_sha256']=m.sha(self.bundle/'install/probe.py');self.write_plan()
  self.version=self.gateway.parent/'cell-runtime-releases/synthetic'
  self.engine=m.Installer(systemctl=str(self.root/'fake-systemctl'),runner=self.run,clock=lambda:self.now,sleep=self.sleep,timeout=.5,stable_seconds=.4,euid=lambda:0,online_probe=lambda *args:{'status':'ok','outcome':'authentication_required'})
  self.patcher=patch.object(m.os,'chown',side_effect=lambda *args:self.chowns.append(args));self.patcher.start()
 def write_plan(self):(self.bundle/'install-plan.json').write_text(json.dumps(self.plan))
 def sleep(self,n):
  self.sleeps+=1;self.now+=n
  if self.on_sleep:self.on_sleep()
 def wrap(self):
  self.parent.mkdir(exist_ok=True)
  self.effective=[sys.executable,str(self.version/'entry.py'),'serve','--gateway-root',str(self.gateway),'--config',str(self.config),'--contract',str(self.version/'excel-contract.json')]
  self.drop.write_text(m.dropin_text(self.effective));self.loaded=[self.drop];self.version.mkdir(parents=True,exist_ok=True);(self.version/'keep').write_text('retained');self.write_state()
 def write_state(self):
  runtime=self.version/'runtime';runtime.mkdir(exist_ok=True,mode=0o700)
  (runtime/'status.json').write_text(json.dumps({'schema':'value-pick-state@1','pid':self.pid,'mode':'original' if self.fail=='degraded' else 'cell','reason':'synthetic component unavailable' if self.fail=='degraded' else None,'recorded_at':'2026-11-15T00:00:00Z'}))
 def facts(self,request):
  state=json.loads((self.version/'runtime/status.json').read_text()) if request.get('component_root') else None
  tools=['case_submit','lease_status']+(['case_submit_cell'] if state and state['mode']=='cell' else [])
  return {'schema':'value-pick-observation@1','component_state':state,'verified':True,'jobs':0,'leased':False,'bed_busy':False,'version':'0.4.7','tools':tools,'task_inventory_sha256':'b'*64,'request_records_sha256':'c'*64,'request_clock_sha256':'d'*64,'diagnostics':['request_clock_included']}
 def run(self,argv,timeout=30,input=None):
  self.calls.append((list(argv),timeout))
  if argv[0]==self.engine.systemctl:
   if argv[1]=='show':
    key=argv[3].split('=',1)[1]
    values={'ExecStart':'{ path='+self.effective[0]+' ; argv[]='+' '.join(self.effective)+' ; ignore_errors=no ; pid=1 ; }','WorkingDirectory':str(self.gateway),'FragmentPath':str(self.fragment),'DropInPaths':' '.join(str(p) for p in self.loaded),'ActiveState':self.active,'SubState':self.sub,'User':pwd.getpwuid(os.getuid()).pw_name,'DynamicUser':'no','NRestarts':str(self.restarts),'MainPID':str(self.pid)}
    return values[key]
   if argv[1]=='daemon-reload':
    if self.fail=='reload' and self.drop.exists() and not self.failed:self.failed=True;raise m.InstallFailure('command','synthetic_reload_failure')
    self.loaded=[self.drop] if self.drop.exists() else []
    self.effective=self.drop.read_text().split('ExecStart=')[-1].strip().split() if self.drop.exists() else list(self.original)
    return ''
   if argv[1]=='restart':
    self.pid=42
    if self.reset_restart_counter:self.restarts=0
    if self.fail=='restart' and self.drop.exists() and not self.failed:self.failed=True;self.active='failed';self.sub='failed';raise m.InstallFailure('command','synthetic_restart_failure')
    if self.fail=='rollback_restart' and not self.drop.exists():self.active='failed';self.sub='failed';raise m.InstallFailure('command','synthetic_rollback_restart_failure')
    self.active='failed' if self.fail=='timeout' and self.drop.exists() else 'active';self.sub='failed' if self.active=='failed' else 'running'
    if self.drop.exists():self.write_state()
    return ''
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
assert m.Installer().timeout==30 and m.Installer().stable_seconds==10
`));

test('install preserves original unit, uses grouped observation phases and produces service-readable new files under umask077',()=>check(`
old=os.umask(0o077)
try:answer=f.engine.install(f.bundle,f.unit)
finally:os.umask(old)
assert answer['ok'] and f.fragment.read_text()=='ORIGINAL UNIT BYTES'
assert f.version.stat().st_mode&0o777==0o755 and f.version.parent.stat().st_mode&0o777==0o755
for name in m.FILES:assert (f.version/name).stat().st_mode&0o777==0o644
for name in ['excel-contract.json','hub-contract.json']:assert (f.version/name).stat().st_mode&0o777==0o600
assert len(f.chowns)==3
assert (f.version/'runtime').stat().st_mode&0o777==0o700
assert any(Path(args[0])==f.version/'runtime' for args in f.chowns)
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
except m.InstallFailure as e:assert e.reason=='service_not_stable' and e.rollback['ok']
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
(proc/'42').mkdir(parents=True);(proc/'42/cgroup').write_text('0::/synthetic.slice\n');(proc/'42/cmdline').write_bytes(('\0'.join(f.original)+'\0').encode())
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
 result=original_run(argv,timeout=timeout,input=input)
 if argv[0]==f.engine.systemctl and argv[1]=='restart':(proc/'42/cmdline').write_bytes(('\0'.join(f.effective)+'\0').encode())
 return result
f.engine.runner=combined
answer=f.engine.install(f.bundle,f.unit)
assert answer['ok']
post=[r for r in seen if r['phase']=='postcheck'];assert len(post)==1 and post[0]['component_root']==str(f.version)
assert f.drop.exists()
`));

test('PID flapping or a non-running sample during the stable interval automatically rolls installation back',()=>check(`
for change in ['pid','status']:
 fired=[False]
 def flap():
  if f.drop.exists() and not fired[0]:
   fired[0]=True
   if change=='pid':f.pid=43
   else:f.active='activating';f.sub='auto-restart'
 f.on_sleep=flap
 try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
 except m.InstallFailure as e:assert e.stage=='restart' and e.rollback['ok'] and e.rollback['restored']
 assert fired[0] and not f.drop.exists()
 f.on_sleep=None
 if f.version.exists():shutil.rmtree(f.version)
`));

test('adjacent restart increases are rejected even after explicit restart resets a higher old baseline',()=>check(`
f.restarts=10;f.reset_restart_counter=True;fired=[False]
def increment():
 if f.drop.exists() and not fired[0]:fired[0]=True;f.restarts=1
f.on_sleep=increment
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:assert e.stage=='restart' and e.rollback['ok']
assert fired[0] and not f.drop.exists()
`));

test('restart increases during startup transitions cannot be hidden by a later running state, and unknown PID or counters cannot prove stability',()=>check(`
f.active='activating';f.sub='start';f.restarts=0
def increment_while_starting():f.restarts=1;f.active='active';f.sub='running'
f.on_sleep=increment_while_starting
assert f.engine.running(f.unit,0) is False
f.on_sleep=None;f.active='active';f.sub='running';f.restarts='unknown'
assert f.engine.running(f.unit,0) is False
f.restarts=0;f.pid=0
assert f.engine.running(f.unit,0) is False
f.pid=42
assert f.engine.running(f.unit,None) is False
`));

test('rollback verifies the original entry with the same stability rule and reports a flapping restoration as unsuccessful',()=>check(`
f.wrap();fired=[False]
def original_flap():
 if not f.drop.exists() and not fired[0]:fired[0]=True;f.pid=99
f.on_sleep=original_flap
answer=f.engine.rollback(f.unit)
assert fired[0] and answer['removed'] and not answer['restored'] and not answer['ok']
assert answer['stage']=='rollback_wait' and f.effective==f.original
`));

test('status identifies original or wrapped release and its exact drop-in without bundle, checker, service actions or filesystem writes',()=>check(`
shutil.rmtree(f.bundle);f.config.unlink()
before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
answer=f.engine.status(f.unit)
assert answer['ok'] and answer['entry']=='original' and answer['release'] is None
assert answer['own_dropin']['present'] is False and answer['observer_required'] is False and answer['idle_checked'] is False
assert before=={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
f.wrap();f.active='failed';f.sub='failed'
before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
answer=f.engine.status(f.unit)
assert answer['entry']=='wrapped' and answer['release']=='synthetic' and answer['own_dropin']['content_matches'] is True
assert answer['before']=={'active':'failed','sub':'failed'}
assert answer['own_dropin']['releases']==['synthetic']
assert before=={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
f.effective=list(f.original);f.loaded=[]
pending=f.engine.status(f.unit)
assert pending['entry']=='original' and pending['release'] is None and pending['own_dropin']['present'] is True
assert pending['own_dropin']['releases']==['synthetic'] and pending['own_dropin']['content_matches'] is True
assert f.requests==[] and all(argv[1]=='show' for argv,t in f.calls)
assert str(f.root) not in json.dumps(answer)
`));

for (const first of [1,10]) test(`first post-restart count ${first} cannot pass against old baseline 10`,()=>check(`
f.restarts=10;original_run=f.run
def raced(argv,timeout=30,input=None):
 result=original_run(argv,timeout=timeout,input=input)
 if argv[0]==f.engine.systemctl and argv[1]=='restart':f.restarts=${first} if f.drop.exists() else 0
 return result
f.engine.runner=raced
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must reject first nonzero count')
except m.InstallFailure as e:assert e.stage=='restart' and e.reason=='service_not_stable' and e.rollback['ok']
assert not f.drop.exists()
`));

test('a running degraded wrapper cannot satisfy installation postcheck and is automatically rolled back',()=>check(`
f.fail='degraded'
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must reject degraded mode')
except m.InstallFailure as e:assert e.stage=='postcheck' and e.reason=='component_not_cell' and e.rollback['ok']
assert not f.drop.exists() and f.effective==f.original
`));

test('status distinguishes current degraded mode from a stale cell state and zero MainPID without inventing a running mode',()=>check(`
f.wrap();f.fail='degraded';f.write_state()
answer=f.engine.status(f.unit)
assert answer['ok'] and answer['entry']=='wrapped' and answer['component_state_current'] is True
assert answer['component_state']['mode']=='original'
f.fail=None;f.write_state();file=f.version/'runtime/status.json';state=json.loads(file.read_text());state['pid']=43;file.write_text(json.dumps(state))
answer=f.engine.status(f.unit)
assert not answer['ok'] and answer['entry']=='wrapped' and answer['component_state_current'] is False and answer['component_state'] is None
f.write_state();f.pid=0;f.active='failed';f.sub='failed'
answer=f.engine.status(f.unit)
assert not answer['ok'] and answer['entry']=='wrapped' and answer['component_state_current'] is False and answer['component_state'] is None
file.unlink();f.pid=42
assert f.engine.status(f.unit)['component_state_current'] is False
`));

test('non-root mutations stop before discovery while read-only operations remain available',()=>check(`
f.engine.euid=lambda:1000
before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
for operation in [lambda:f.engine.install(f.bundle,f.unit),lambda:f.engine.rollback(f.unit)]:
 try:operation();raise AssertionError('must require root')
 except m.InstallFailure as e:assert e.stage=='identity' and e.reason=='root_required'
assert f.calls==[] and before=={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
assert f.engine.preflight(f.bundle,f.unit)['facts']['jobs']==0
assert f.engine.status(f.unit)['entry']=='original'
`));

test('an unloaded drop-in is removed without restarting the original running PID',()=>check(`
f.parent.mkdir()
argv=[sys.executable,str(f.version/'entry.py'),'serve','--gateway-root',str(f.gateway),'--config',str(f.config),'--contract',str(f.version/'excel-contract.json')]
f.drop.write_text(m.dropin_text(argv));f.restarts=4
answer=f.engine.rollback(f.unit)
assert answer['ok'] and not answer['restart_performed'] and not f.drop.exists()
assert f.pid==42 and f.restarts==4 and not any(a[1]=='restart' for a,t in f.calls)
again=f.engine.rollback(f.unit)
assert again['ok'] and again['stage']=='already_original'
assert not any(a[1]=='restart' for a,t in f.calls)
`));

test('rollback resumes after interrupted removal or reload using its durable ownership receipt',()=>check(`
for point in ['reload','restart']:
 f.wrap();original=f.run;fired=[False]
 def interrupt(argv,timeout=30,input=None):
  if argv[0]==f.engine.systemctl and argv[1]==('daemon-reload' if point=='reload' else 'restart') and not f.drop.exists() and not fired[0]:
   fired[0]=True;raise KeyboardInterrupt()
  return original(argv,timeout=timeout,input=input)
 f.engine.runner=interrupt
 partial=f.engine.rollback(f.unit)
 assert fired[0] and not partial['ok'] and partial['resume_available']
 assert not f.drop.exists() and len(list(f.parent.glob('.value-pick-rollback-*.json')))==1
 f.engine.runner=original
 final=f.engine.rollback(f.unit)
 assert final['ok'] and final['resumed'] and final['restored']
 assert not list(f.parent.glob('.value-pick-rollback-*.json'))
 assert (f.version/'keep').read_text()=='retained'
`));

test('a restart interrupted before checkpoint is recognized by its changed original PID',()=>check(`
f.wrap();original=f.run;fired=[False]
def interrupt(argv,timeout=30,input=None):
 result=original(argv,timeout=timeout,input=input)
 if argv[0]==f.engine.systemctl and argv[1]=='restart' and not fired[0]:
  fired[0]=True;f.pid=99;raise KeyboardInterrupt()
 return result
f.engine.runner=interrupt
partial=f.engine.rollback(f.unit);assert not partial['ok'] and partial['resume_available']
f.engine.runner=original;prior=len([a for a,t in f.calls if a[1]=='restart'])
final=f.engine.rollback(f.unit)
assert final['ok'] and final['restored'] and not final['restart_performed']
assert len([a for a,t in f.calls if a[1]=='restart'])==prior
`));

test('INT TERM and HUP during install roll back and restore previous signal handlers',()=>check(`
import signal
for signum in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:
 original=f.run;fired=[False];previous=signal.getsignal(signum)
 def terminate(argv,timeout=30,input=None):
  result=original(argv,timeout=timeout,input=input)
  if argv[0]==f.engine.systemctl and argv[1]=='daemon-reload' and f.drop.exists() and not fired[0]:
   fired[0]=True;os.kill(os.getpid(),signum)
  return result
 f.engine.runner=terminate
 with m.interrupt_signals():
  try:f.engine.install(f.bundle,f.unit);raise AssertionError('must interrupt')
  except m.InstallFailure as e:assert e.reason=='interrupted' and e.rollback['ok']
 assert fired[0] and not f.drop.exists() and signal.getsignal(signum)==previous
 f.engine.runner=original;shutil.rmtree(f.version)
`));

test('termination in the atomic publication window still rolls back the owned drop-in',()=>check(`
import signal
original=m.os.link
def terminate(src,dst):
 original(src,dst);os.kill(os.getpid(),signal.SIGTERM)
with m.interrupt_signals(),patch.object(m.os,'link',terminate):
 try:f.engine.install(f.bundle,f.unit);raise AssertionError('must interrupt')
 except m.InstallFailure as e:assert e.reason=='interrupted' and e.rollback['ok']
assert not f.drop.exists() and not any(a[1]=='restart' for a,t in f.calls)
`));

test('failed online postcheck rolls back instead of trusting static tools',()=>check(`
seen=[]
def offline(config,timeout):
 seen.append((config,timeout));return {'status':'ok','outcome':'authentication_required'} if len(seen)==1 else {'status':'error','outcome':'connection_or_response_failed'}
f.engine.online_probe=offline
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:
 assert e.stage=='online_probe' and e.reason=='online_probe_failed' and e.rollback['ok']
 assert e.details['probe']['outcome']=='connection_or_response_failed'
assert len(seen)==2 and all(config==f.config for config,timeout in seen) and not f.drop.exists()
`));

test('request clock drift has a distinct failure without weakening inventory equality',()=>check(`
state=f.engine.preflight(f.bundle,f.unit)
state['facts']['request_clock_sha256']='a'*64
original=f.engine.observe
def changed(*args):
 facts=original(*args);return {**facts,'request_records_sha256':'d'*64,'request_clock_sha256':'e'*64}
f.engine.observe=changed;f.engine.stage='copy_version'
try:f.engine.guard(f.bundle,state,f.unit);raise AssertionError('must reject')
except m.InstallFailure as e:assert e.reason=='request_clock_changed'
`));

test('rollback can resume from an initially absent main PID without restarting the restored original process twice',()=>check(`
f.wrap();f.pid=0;f.active='failed';f.sub='failed';original=f.run;fired=[False]
def interrupted(argv,timeout=30,input=None):
 result=original(argv,timeout=timeout,input=input)
 if argv[0]==f.engine.systemctl and argv[1]=='restart' and not fired[0]:
  fired[0]=True;raise KeyboardInterrupt()
 return result
f.engine.runner=interrupted
partial=f.engine.rollback(f.unit)
assert not partial['ok'] and partial['resume_available']
assert f.engine.status(f.unit)['rollback_pending'] is True
f.engine.runner=original;prior=len([a for a,t in f.calls if a[1]=='restart'])
final=f.engine.rollback(f.unit)
assert final['ok'] and final['restored'] and not final['restart_performed']
assert len([a for a,t in f.calls if a[1]=='restart'])==prior
assert f.engine.status(f.unit)['rollback_pending'] is False
`));

test('preflight explanations distinguish auxiliary processes clocks and missing alive locks without printing values',()=>check(`
details=m.observation_details({'diagnostics':['cgroup_extra_processes','request_clock_included','task_alive_missing']})
assert len(details['notes'])==3
assert any('短命读取' in note for note in details['notes'])
assert any('时钟' in note for note in details['notes'])
assert any('存活锁' in note for note in details['notes'])
`));

test('a broken SSH progress pipe after activation invokes rollback before exit',()=>check(`
def lost(phase):
 if phase=='postcheck':raise BrokenPipeError()
f.engine.progress=lost
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must roll back a broken control channel')
except m.InstallFailure as e:assert e.reason=='connection_lost' and e.rollback['ok']
assert not f.drop.exists() and f.effective==f.original
`));

test('a second interruption before rollback starts is reported as resumable rather than before activation',()=>check(`
f.fail='postcheck';original=f.engine.rollback
def interrupted(*args):raise KeyboardInterrupt()
f.engine.rollback=interrupted
try:f.engine.install(f.bundle,f.unit);raise AssertionError('must fail')
except m.InstallFailure as e:
 assert e.stage=='postcheck' and e.rollback['reason']=='interrupted' and e.rollback['resume_available']
 assert e.rollback['removed'] is None and f.drop.exists()
f.engine.rollback=original
assert f.engine.rollback(f.unit)['ok'] and not f.drop.exists()
`));


// Boss15:13 future-candidate follow-ups. UNRUN while the shared full-test.lock is active.
test('a final installed progress receipt failure retains the already verified healthy installation',()=>check(`
rollbacks=[];original=f.engine.rollback
def watched(*args):rollbacks.append(args);return original(*args)
def lost_final(phase):
 if phase=='installed':raise BrokenPipeError('SYNTHETIC_PRIVATE_CONFIG_VALUE')
f.engine.rollback=watched;f.engine.progress=lost_final
answer=f.engine.install(f.bundle,f.unit)
assert answer['ok'] and answer['stage']=='installed' and answer['receipt_warning']=='installed_receipt_unavailable'
assert f.drop.exists() and rollbacks==[] and f.active=='active' and f.sub=='running'
assert len([a for a,t in f.calls if a[1]=='restart'])==1
assert str(f.root) not in json.dumps(answer) and 'SYNTHETIC_PRIVATE_CONFIG_VALUE' not in json.dumps(answer)
`));

test('preflight rejects rollback progress from an older release with actionable recovery guidance before any write',()=>check(`
f.parent.mkdir();marker=f.parent/'.value-pick-rollback-older-release.json';marker.write_text('SYNTHETIC DO NOT PARSE OR DELETE')
before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
try:f.engine.preflight(f.bundle,f.unit);raise AssertionError('must refuse pending rollback')
except m.InstallFailure as e:
 assert e.reason=='rollback_progress_pending' and e.details['rollback_releases']==['older-release']
 assert 'rollback --unit' in e.details['next_action'] and '--release' in e.details['next_action'] and 'root' in e.details['next_action']
 assert str(f.root) not in json.dumps(e.report())
assert before=={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
assert not f.version.exists() and not f.drop.exists()
assert all(a[1]=='show' for a,t in f.calls)
`));

test('preflight probe failure rejects installation before copying exporting activating or restarting',()=>check(`
for outcome in ['listen_config_unavailable','connection_or_response_failed','timeout']:
 seen=[]
 def failed(config,timeout):seen.append((config,timeout));return {'status':'error','outcome':outcome}
 f.engine.online_probe=failed
 before={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
 try:f.engine.install(f.bundle,f.unit);raise AssertionError('must refuse failed original gateway probe')
 except m.InstallFailure as e:
  assert e.stage=='preflight_probe' and e.reason=='online_probe_failed' and e.rollback is None
  assert e.details['probe']=={'status':'error','outcome':outcome}
  assert str(f.root) not in json.dumps(e.report())
 assert len(seen)==1 and seen[0][0]==f.config
 assert before=={str(p.relative_to(f.root)):p.read_bytes() for p in f.root.rglob('*') if p.is_file()}
 assert not f.version.exists() and not f.parent.exists()
`));

test('the original gateway and installed gateway share the same credential-free probe interface',()=>check(`
seen=[]
def healthy(config,timeout):seen.append((config,timeout));return {'status':'ok','outcome':'authentication_required'}
f.engine.online_probe=healthy
state=f.engine.preflight(f.bundle,f.unit)
assert state['online_probe']=={'status':'ok','outcome':'authentication_required'} and len(seen)==1
assert not f.version.exists() and not f.drop.exists()
answer=f.engine.install(f.bundle,f.unit)
assert answer['ok'] and len(seen)==3
assert all(config==f.config and timeout==f.engine.timeout for config,timeout in seen)
assert answer['online_probe']==state['online_probe']
`));
