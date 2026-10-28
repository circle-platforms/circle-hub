// Pure safety-contract negatives plus an opt-in root VM proof; never accepts a real backup or a key pipeline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertCanonicalPath,assertSameIdentity,parseMountInfo,sourceMountReceipt,trustedRootMount,verifyMountTable,isolatedUnitArguments, proveSyntheticIsolation, type IsolationDefinition} from './testing/linux-rehearsal-isolation.ts';
const fixture:IsolationDefinition={unit:'chvm-123456abcdef-probe',user:'chvm-123456abcdef',namespace:'chvm-123456abcdef',root:'/var/tmp/chvm-123456abcdef',data:'/var/tmp/chvm-123456abcdef/data',release:'/var/tmp/chvm-build-123456abcdef/release',node:'/usr/bin/node'};
test('isolated units require rootfs and netns plus capability and host-filesystem restrictions',()=>{
 const args=isolatedUnitArguments(fixture,['/runtime/node','/release/bin/circle-hub','serve']);
 for(const property of [`RootDirectory=${fixture.root}`,`NetworkNamespacePath=/run/netns/${fixture.namespace}`,'CapabilityBoundingSet=','NoNewPrivileges=yes','ProtectProc=invisible','ProcSubset=pid','PrivateDevices=yes','PrivateMounts=yes','RestrictNamespaces=yes','ProtectSystem=strict','ReadWritePaths=/data','KillMode=control-group','Restart=no'])assert.ok(args.includes(property));
 assert.ok(args.includes('User='+fixture.user));
 assert.ok(!args.some(arg=>arg.includes('BindPaths=/home')||arg.includes('BindPaths=/mnt')));
});
test('foreign identities, escaping paths, external roots and arbitrary executables are rejected',()=>{
 for(const patch of [{user:'root'},{namespace:'production'},{unit:'circle-hub'},{release:'/var/tmp/x:/home'},{root:'/var/tmp/../home'},{data:'/var/lib/circle-hub'},{root:'/',data:'/data'},{namespace:'chvm-abcdef123456'},{unit:'chvm-abcdef123456-probe'},{root:'/var/tmp/chvm-abcdef123456',data:'/var/tmp/chvm-abcdef123456/data'},{release:'/var/tmp/chvm-build-anything/release'},{root:'/var/tmp//chvm-123456abcdef'}])assert.throws(()=>isolatedUnitArguments({...fixture,...patch},['/runtime/node','/release/bin/circle-hub']));
 assert.throws(()=>isolatedUnitArguments(fixture,['/bin/sh','-c','ignored']));
});
test('root-managed synthetic VM isolation establishes outbound denial and child inheritance',{
 skip:process.env.CIRCLE_HUB_TEST_ISOLATION_VM===undefined?'requires administrator-declared disposable VM and fresh closed release build':false,
 timeout:2_400_000,
},async()=>{
 await proveSyntheticIsolation();
});

test('host-library submount and shared source negatives reproduce the mount leak boundary',()=>{
 const local=parseMountInfo('1 0 8:1 / / rw - ext4 /dev/synthetic rw');
 const nested=parseMountInfo('2 1 0:42 /host/private /usr/lib/shared rw - virtiofs shared rw');
 assert.throws(()=>sourceMountReceipt([...local,...nested],'/usr/lib','/usr/lib',trustedRootMount(local)));
 assert.throws(()=>sourceMountReceipt(nested,'/usr/lib/shared','/usr/lib',trustedRootMount(local)));
 const receipt=sourceMountReceipt(local,'/usr/lib','/usr/lib',trustedRootMount(local));
 verifyMountTable([{device:'8:1',root:'/usr/lib',target:'/usr/lib',fs:'ext4'}],[receipt]);
 assert.throws(()=>verifyMountTable([{device:'8:1',root:'/home/private',target:'/usr/lib',fs:'ext4'}],[receipt]));
 assert.throws(()=>verifyMountTable([{device:'8:1',root:'/usr/lib',target:'/usr/lib',fs:'ext4'},...nested],[receipt]));
 assert.throws(()=>verifyMountTable([{device:'8:1',root:'/usr/lib',target:'/usr/lib',fs:'ext4'},{device:'0:19',root:'/private',target:'/run/shared',fs:'tmpfs'}],[receipt]));
});
test('replaced resource identity is rejected before any name-based deletion',()=>{
 const created={dev:8,ino:101,uid:0,mode:0o40700};
 assertSameIdentity({...created},created);
 for(const patch of [{dev:9},{ino:102},{uid:1000},{mode:0o120777},{mode:0o40777}])assert.throws(()=>assertSameIdentity({...created,...patch},created));
});
test('canonical path check rejects symbolic and lexical reparsing of a synthetic path',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chvm-path-'));
 try{await symlink(directory,join(directory,'alias'));await assert.rejects(assertCanonicalPath(join(directory,'alias')));await assert.rejects(assertCanonicalPath(directory+'/../'+directory.split('/').pop()));}
 finally{await rm(directory,{recursive:true});}
});

test('same-device production bind over the source itself cannot self-certify its backing root',()=>{
 const before=parseMountInfo('1 0 8:1 / / rw - ext4 /dev/synthetic rw');
 const baseline=trustedRootMount(before);
 for(const source of ['/var/tmp/chvm-build-123456abcdef/release','/usr/lib']){
  const covered=parseMountInfo(`2 1 8:1 /srv/production-release ${source} rw - ext4 /dev/synthetic rw`);
  assert.throws(()=>sourceMountReceipt([...before,...covered],source,'/release',baseline));
 }
 const ancestor=parseMountInfo('3 1 8:1 /srv/production /var/tmp rw - ext4 /dev/synthetic rw');
 assert.throws(()=>sourceMountReceipt([...before,...ancestor],'/var/tmp/chvm-build-123456abcdef/release','/release',baseline));
 const switched=parseMountInfo('1 0 8:2 / / rw - ext4 /dev/other rw');
 assert.throws(()=>sourceMountReceipt(switched,'/usr/lib','/usr/lib',baseline));
 assert.throws(()=>trustedRootMount(parseMountInfo('1 0 8:1 /srv/production / rw - ext4 /dev/synthetic rw')));
});
