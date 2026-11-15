import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const observer = fileURLToPath(new URL('./observe.py', import.meta.url));
const installer = fileURLToPath(new URL('./installer.py', import.meta.url));
// Only synthetic files, SQLite and proc/cgroup trees are inspected; no services run.
const program = String.raw`
import ast,fcntl,hashlib,importlib.util,json,os,sqlite3,sys,tempfile,time
from pathlib import Path
from contextlib import closing
p=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('synthetic_observer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def write(path,text=''):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);return path
with tempfile.TemporaryDirectory(prefix='synthetic-observe-') as tmp:
    root=Path(tmp);gw=root/'gateway-root';state=root/'state';staging=root/'staging';proc=root/'proc';cg=root/'cgroup';component=root/'component'
    state.mkdir();staging.mkdir();(state/'tasks').mkdir();write(state/'bed.lock')
    config=write(root/'gateway.toml','[state]\ndir="'+str(state)+'"\n[framework]\nstaging_parent="'+str(staging)+'"\n[hub]\nsecret_sha256_file="DO_NOT_READ"\n')
    write(gw/'gateway/service.py',"raise RuntimeError('source must never be imported')\nSERVER_INFO={'version':'0.4.7'}\n")
    write(gw/'gateway/tools.py',"raise RuntimeError('source must never be imported')\nTOOL_SPECS: list = [{'name':'lease_status','input_schema':unavailable_function()},{'name':'case_submit'}]\n")
    write(component/'entry.py',"raise RuntimeError('wrapper must never be imported')\n")
    write(component/'cell_gateway.py',"SUBMIT_TOOL='case_submit_cell'\nraise RuntimeError('wrapper must never be imported')\n")
    group='/synthetic.slice/test.service';main=123
    write(proc/str(main)/'cgroup','0::'+group+'\n');write(proc/'sys/kernel/random/boot_id','synthetic-boot\n')
    write(cg/'cgroup.controllers','cpu memory\n');procs=write(cg/group.lstrip('/')/'cgroup.procs','123\n')
    original=[sys.executable,'-m','gateway.cexg','serve','--config',str(config)]
    wrapped=[sys.executable,str(component/'entry.py'),'serve','--gateway-root',str(gw),'--config',str(config),'--contract',str(component/'excel-contract.json')]
    launch=list(original)
    write(proc/str(main)/'cmdline','\0'.join(original)+'\0')
    def properties(unit):
        import shlex
        return {'MainPID':str(main),'ControlGroup':group,'WorkingDirectory':str(gw),'ExecStart':'{ path='+sys.executable+' ; argv[]='+shlex.join(launch)+' ; ignore_errors=no ; }'}
    db=sqlite3.connect(state/'state.db')
    db.executescript('CREATE TABLE lease(bed TEXT,released INTEGER,clock_epoch TEXT,monotonic_deadline REAL,expires_at REAL,token TEXT);CREATE TABLE tasks(task_id TEXT);CREATE TABLE requests(request_id TEXT,reply TEXT);')
    db.execute('INSERT INTO requests VALUES(?,?)',('legacy','SYNTHETIC_LEGACY_SECRET'))
    db.commit();db.close()
    journal=state.with_name(state.name+'.request-journal');journal.mkdir();jdb=journal/'requests.db'
    db=sqlite3.connect(jdb)
    db.executescript('CREATE TABLE requests(request_id TEXT,holder TEXT,reply TEXT,dispatch_sequence INTEGER,sequence_scope TEXT);CREATE TABLE request_events(event_id INTEGER);CREATE TABLE request_meta(name TEXT,value TEXT);CREATE TABLE request_tombstones(request_id TEXT,not_after REAL);')
    db.execute('INSERT INTO requests VALUES(?,?,?,?,?)',('synthetic-request','synthetic-holder','SYNTHETIC_PRIVATE_REPLY',1,'synthetic-scope'));db.execute('INSERT INTO request_meta VALUES(?,?)',('storage_id','synthetic-identity'));db.execute('INSERT INTO request_events VALUES(1)');db.commit();db.close()
    request={'operation':'observe','unit':'test.service','phase':'preflight','gateway_root':str(gw),'config_path':str(config)}
    def run():return m.observe(request,proc_root=proc,cgroup_root=cg,properties=properties)
    mode=p.get('mode','idle');handles=[];extra={}
    if mode=='child':
        procs.write_text('123\n456\n');write(procs.parent/'nested/cgroup.procs','789\n')
    if mode in ('lock','bed-lock','missing-alive'):
        with sqlite3.connect(state/'state.db') as c:c.execute('INSERT INTO tasks VALUES(?)',('synthetic-task',))
        if mode!='missing-alive':write(state/'tasks/synthetic-task.alive')
        if mode=='lock':
            h=(state/'tasks/synthetic-task.alive').open('rb');fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB);handles.append(h)
        if mode=='bed-lock':
            h=(state/'bed.lock').open('rb');fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB);handles.append(h)
    if mode=='v1':
        (cg/'cgroup.controllers').unlink();write(proc/str(main)/'cgroup','1:name=systemd:'+group+'\n');write(cg/'systemd'/group.lstrip('/')/'cgroup.procs','123\n')
    if mode=='unknown-cgroup':write(proc/str(main)/'cgroup','3:unexpected:'+group+'\n')
    if mode=='missing-db':(state/'state.db').unlink()
    if mode=='wrong-schema':
        with sqlite3.connect(state/'state.db') as c:c.execute('DROP TABLE lease');c.execute('CREATE TABLE lease(expires_at REAL)')
    if mode=='phase':
        launch[:]=wrapped
        write(proc/str(main)/'cmdline','\0'.join(wrapped)+'\0')
        write(component/'runtime/status.json',json.dumps({'schema':'value-pick-state@1','pid':main,'mode':'cell','reason':None,'recorded_at':'2026-11-15T00:00:00Z'}));request['phase']='postcheck'
    if mode=='wrong-phase':request['phase']='postcheck'
    if mode=='config':config.write_text(p['text'].replace('STATE',str(state)).replace('STAGING',str(staging)))
    if mode=='lease':
        result=[]
        for released,epoch,deadline in [(0,'synthetic-boot',time.monotonic()+1000),(0,'synthetic-boot',time.monotonic()-1000),(1,'synthetic-boot',time.monotonic()+1000),(0,'previous-boot',time.monotonic()+1000),(0,'synthetic-boot',None),(0,None,time.monotonic()+1000)]:
            with sqlite3.connect(state/'state.db') as c:
                c.execute('DELETE FROM lease');c.execute('INSERT INTO lease VALUES(?,?,?,?,?,?)',('bed',released,epoch,deadline,0,'SYNTHETIC_LEASE_TOKEN'))
            result.append(run()['leased'])
        extra['lease_states']=result
    if mode=='durable':
        before=run()['request_records_sha256']
        with sqlite3.connect(jdb) as c:c.execute('DELETE FROM request_events')
        extra['queue_flush_same']=run()['request_records_sha256']==before
        with sqlite3.connect(state/'state.db') as c:c.execute('UPDATE requests SET reply=?',('legacy-edited',))
        extra['legacy_ignored']=run()['request_records_sha256']==before
        hashes=[before]
        for sql in ["UPDATE requests SET reply='changed'","UPDATE requests SET dispatch_sequence=2","UPDATE requests SET sequence_scope='changed'","UPDATE request_meta SET value='identity-changed'","INSERT INTO request_tombstones VALUES('deleted',3)"]:
            with sqlite3.connect(jdb) as c:c.execute(sql)
            hashes.append(run()['request_records_sha256'])
        extra['all_persistent_changes']=len(set(hashes))==len(hashes)
    if mode=='wal':
        writer=sqlite3.connect(jdb);writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA wal_autocheckpoint=0')
        before=run()['request_records_sha256'];writer.execute("UPDATE requests SET reply='committed-in-wal'");writer.commit()
        extra['wal_exists']=jdb.with_name('requests.db-wal').stat().st_size>0
        extra['sees_committed_wal']=run()['request_records_sha256']!=before
    if mode=='symlinks':
        write(root/'shared/test_xlsx.py','SHARED_NEVER_READ');(staging/'test_xlsx.py').symlink_to(root/'shared/test_xlsx.py')
        (staging/'excel_contract.json').symlink_to(root/'missing-contract')
        (staging/'linked-dir').symlink_to(root/'shared',target_is_directory=True)
        before=run()['task_inventory_sha256'];(staging/'excel_contract.json').unlink();(staging/'excel_contract.json').symlink_to(root/'other-missing-contract')
        extra['changed_link_target']=run()['task_inventory_sha256']!=before
        current=run()['task_inventory_sha256'];write(root/'shared/test_xlsx.py','CHANGED_TARGET_NOT_FOLLOWED')
        extra['not_followed']=run()['task_inventory_sha256']==current
    if mode=='bytes':
        f=write(state/'tasks/synthetic-task.log','first');write(state/'tasks/synthetic-task.alive')
        rows=m.inventory(state/'tasks');extra['byte_hash']=next(row[-1] for row in rows if row[0]=='synthetic-task.log')==hashlib.sha256(b'first').hexdigest()
        before=run()['task_inventory_sha256'];f.write_text('other');extra['changed_bytes']=run()['task_inventory_sha256']!=before
    if mode in ('cell','degraded','missing-status','missing-state-pid','stale-state','invalid-state','state-symlink','zero-mainpid','pending-reload'):
        launch[:]=wrapped
        request['phase']='postcheck'
        if mode=='pending-reload':
            request['phase']='restart'
        else:
            write(proc/str(main)/'cmdline','\0'.join(wrapped)+'\0')
            state_document={'schema':'value-pick-state@1','pid':main,'mode':'original' if mode=='degraded' else 'cell','reason':'synthetic component unavailable' if mode=='degraded' else None,'recorded_at':'2026-11-15T00:00:00Z'}
            if mode=='stale-state':state_document['pid']=main+1
            if mode=='missing-state-pid':state_document.pop('pid')
            if mode=='invalid-state':state_document['recorded_at']='2026-11-15T00:00:00+05:00'
            if mode=='state-symlink':
                target=write(root/'synthetic-state.json',json.dumps(state_document));(component/'runtime').mkdir();(component/'runtime/status.json').symlink_to(target)
            elif mode!='missing-status':write(component/'runtime/status.json',json.dumps(state_document))
            if mode=='zero-mainpid':main=0
    def snapshot():
        rows=[]
        for f in root.rglob('*'):
            if f.is_file() and not f.is_symlink():rows.append((str(f.relative_to(root)),hashlib.sha256(f.read_bytes()).hexdigest(),f.stat().st_mode,f.stat().st_mtime_ns))
            elif f.is_symlink():rows.append((str(f.relative_to(root)),os.readlink(f)))
        return sorted(rows)
    before=snapshot();facts=run();extra['unchanged']=snapshot()==before
    if mode=='lock':
        try:
            fd=os.open(state/'tasks/synthetic-task.alive',os.O_RDONLY)
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);extra['lock_still_held']=False
            except BlockingIOError:extra['lock_still_held']=True
            finally:os.close(fd)
        finally:pass
    if mode=='installer':
        import shutil
        si=importlib.util.spec_from_file_location('synthetic_installer',sys.argv[2]);i=importlib.util.module_from_spec(si);si.loader.exec_module(i)
        bundle=root/'bundle';(bundle/'install').mkdir(parents=True);target=bundle/'install/observe.py';shutil.copyfile(sys.argv[1],target);target.chmod(0o600)
        plan={'checker_sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
        calls=[]
        def invoke(argv,timeout=30,input=None):
            calls.append(argv)
            if argv[0]=='systemctl':
                assert argv[1]=='show' and argv[-1]=='--value'
                return properties('test.service')[argv[-2].split('=',1)[1]]
            assert argv[0]==sys.executable and Path(argv[1])==target
            return json.dumps(m.observe(json.loads(input),proc_root=proc,cgroup_root=cg,properties=properties))
        ctrl=i.Installer(runner=invoke)
        base={'gateway_root':gw,'config':config,'component':None}
        first=ctrl.observe(bundle,plan,'test.service',base,'preflight')
        launch[:]=wrapped
        write(proc/str(main)/'cmdline','\0'.join(wrapped)+'\0')
        write(component/'runtime/status.json',json.dumps({'schema':'value-pick-state@1','pid':main,'mode':'cell','reason':None,'recorded_at':'2026-11-15T00:00:00Z'}))
        second=ctrl.observe(bundle,plan,'test.service',{**base,'component':component},'postcheck')
        ctrl.stage='postcheck'
        from_guard=ctrl.guard(bundle,{'plan':plan,'launch':base,'facts':first},'test.service')
        extra['stale_launch_guard']=from_guard['tools']==['case_submit','case_submit_cell','lease_status']
        extra['composition']=first['tools']==['case_submit','lease_status'] and second['tools']==['case_submit','case_submit_cell','lease_status']
        extra['non_executable_observer']=target.stat().st_mode&0o777==0o600
    ast.parse(Path(sys.argv[1]).read_text(),feature_version=(3,8))
    for h in handles:h.close()
    print(json.dumps({'facts':facts,**extra}))
`;
function run(mode: string, extra: Record<string, unknown> = {}) {
  const result = spawnSync('python3', ['-B', '-c', program, observer, installer], {
    input: JSON.stringify({mode, ...extra}), encoding: 'utf8', env: {PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1'},
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.doesNotMatch(result.stdout, /SYNTHETIC_(?:PRIVATE_REPLY|LEASE_TOKEN|LEGACY_SECRET)|DO_NOT_READ/);
  return JSON.parse(result.stdout);
}

test('idle facts use static declarations without module imports and leave files unchanged', () => {
  const r = run('idle'); assert.equal(r.facts.verified, true); assert.equal(r.facts.jobs, 0);
  assert.equal(r.facts.leased, false); assert.equal(r.facts.bed_busy, false);
  assert.equal(r.facts.version, '0.4.7'); assert.deepEqual(r.facts.tools, ['case_submit', 'lease_status']);
  assert.match(r.facts.task_inventory_sha256, /^[a-f0-9]{64}$/); assert.match(r.facts.request_records_sha256, /^[a-f0-9]{64}$/);
  assert.equal(r.unchanged, true);
});
test('cgroup children and nested cgroups are active evidence and v1 systemd membership is recognized', () => {
  assert.equal(run('child').facts.jobs, 2); assert.equal(run('v1').facts.jobs, 0);
  const unknown = run('unknown-cgroup'); assert.equal(unknown.facts.jobs, null); assert.equal(unknown.facts.verified, false);
});
test('nonblocking live locks are not stolen and absent legacy alive files remain unknown', () => {
  const held = run('lock'); assert.equal(held.facts.jobs, 1); assert.equal(held.lock_still_held, true); assert.equal(held.unchanged, true);
  assert.equal(run('bed-lock').facts.bed_busy, true);
  const missing = run('missing-alive'); assert.equal(missing.facts.jobs, null); assert.equal(missing.facts.verified, false); assert.equal(missing.unchanged, true);
});
test('lease state uses released boot epoch and monotonic deadline rather than wall expiry', () => {
  assert.deepEqual(run('lease').lease_states, [true, false, false, false, false, false]);
  for (const mode of ['missing-db', 'wrong-schema']) {const r = run(mode); assert.equal(r.facts.leased, null); assert.equal(r.facts.verified, false); assert.equal(r.unchanged, true);}
});
test('request identity excludes flushed audit queue and legacy rows but covers complete durable facts', () => {
  const r = run('durable'); assert.equal(r.queue_flush_same, true); assert.equal(r.legacy_ignored, true); assert.equal(r.all_persistent_changes, true); assert.equal(r.unchanged, true);
});
test('read-only request snapshots include committed WAL content', () => {
  const r = run('wal'); assert.equal(r.wal_exists, true); assert.equal(r.sees_committed_wal, true); assert.equal(r.facts.verified, true); assert.equal(r.unchanged, true);
});
test('normal staged symlinks are hashed without following shared or missing targets', () => {
  const r = run('symlinks'); assert.equal(r.facts.verified, true); assert.equal(r.changed_link_target, true); assert.equal(r.not_followed, true); assert.equal(r.unchanged, true);
});
test('critical regular task files carry byte hashes and changed bytes alter the inventory', () => {
  const r = run('bytes'); assert.equal(r.byte_hash, true); assert.equal(r.changed_bytes, true); assert.equal(r.facts.verified, true); assert.equal(r.unchanged, true);
});
test('postcheck derives wrapper tools from the current MainPID and its recorded component state', () => {
  assert.deepEqual(run('phase').facts.tools, ['case_submit', 'case_submit_cell', 'lease_status']);
  const wrong = run('wrong-phase'); assert.equal(wrong.facts.tools, null); assert.equal(wrong.facts.verified, false);
});
test('restricted config parsing needs no tomllib and rejects duplicates escapes and complex forms', () => {
  assert.equal(run('config', {text: "[state]\ndir='STATE'\n[framework]\nstaging_parent='STAGING'\n"}).facts.verified, true);
  for (const text of ['[state]\ndir="STATE"\ndir="STATE"\n[framework]\nstaging_parent="STAGING"', '[state]\ndir="STATE\\escape"\n[framework]\nstaging_parent="STAGING"', '[state]\ndir={path="STATE"}\n[framework]\nstaging_parent="STAGING"']) {
    assert.equal(run('config', {text}).facts.verified, false);
  }
});
test('installer calls its hashed non-executable observation program through the Python interpreter', () => {
  const r = run('installer'); assert.equal(r.composition, true); assert.equal(r.stale_launch_guard, true); assert.equal(r.non_executable_observer, true);
});

test('the stdin entry returns only unknown facts for malformed JSON without inspecting a host', () => {
  const result = spawnSync('python3', ['-B', observer], {input: '{', encoding: 'utf8', env: {PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1'}});
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const facts = JSON.parse(result.stdout); assert.equal(facts.verified, false); assert.equal(facts.jobs, null); assert.equal(facts.leased, null);
  assert.deepEqual(Object.keys(facts).sort(), ['schema','jobs','leased','bed_busy','version','tools','component_state','task_inventory_sha256','request_records_sha256','verified'].sort());
});

test('current component state selects cell tools or a truthful original-only degraded observation', () => {
  const cell=run('cell'); assert.equal(cell.facts.verified,true); assert.equal(cell.facts.component_state.mode,'cell');
  assert.deepEqual(cell.facts.tools,['case_submit','case_submit_cell','lease_status']);
  const degraded=run('degraded'); assert.equal(degraded.facts.verified,true); assert.equal(degraded.facts.component_state.mode,'original');
  assert.deepEqual(degraded.facts.tools,['case_submit','lease_status']); assert.equal(degraded.unchanged,true);
});

test('missing stale non-UTC or symlinked state and a missing positive current PID stay unknown', () => {
  for(const mode of ['missing-status','missing-state-pid','stale-state','invalid-state','state-symlink','zero-mainpid']) {
    const r=run(mode); assert.equal(r.facts.verified,false,mode); assert.equal(r.facts.component_state,null,mode); assert.equal(r.facts.tools,null,mode); assert.equal(r.unchanged,true,mode);
  }
});

test('a loaded future ExecStart does not pretend the still-original MainPID has a wrapper state', () => {
  const r=run('pending-reload'); assert.equal(r.facts.verified,true); assert.equal(r.facts.component_state,null);
  assert.deepEqual(r.facts.tools,['case_submit','lease_status']); assert.equal(r.unchanged,true);
});
