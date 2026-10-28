// Pure safety-contract negatives plus an opt-in root VM proof; never accepts a real backup or a key pipeline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,symlink,rm,lstat,writeFile,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from './process.ts';
import {publicLockedTarballs,stableCacheIndex} from './testing/prepare-offline-bundle.ts';
import {createHash} from 'node:crypto';
import {hubMigrationProgram} from './testing/hub-migration-program.ts';
import {assertCanonicalPath,assertSameIdentity,parseMountInfo,sourceMountReceipt,trustedRootMount,offlineBuildProgram,verifyOfflineBundle,namespaceEscapeProgram,assertBuiltTreeBudget,verifyMountTable,isolatedUnitArguments, proveSyntheticIsolation, type IsolationDefinition} from './testing/linux-rehearsal-isolation.ts';
const fixture:IsolationDefinition={unit:'chvm-123456abcdef-probe',user:'chvm-123456abcdef',namespace:'chvm-123456abcdef',root:'/var/tmp/chvm-123456abcdef',data:'/var/tmp/chvm-123456abcdef/data',release:'/var/tmp/chvm-build-123456abcdef/release',node:'/usr/bin/node'};
test('isolated units require rootfs and netns plus capability and host-filesystem restrictions',()=>{
 const args=isolatedUnitArguments(fixture,['/runtime/node','/release/bin/circle-hub','serve']);
 for(const property of [`RootDirectory=${fixture.root}`,`NetworkNamespacePath=/run/netns/${fixture.namespace}`,'CapabilityBoundingSet=','NoNewPrivileges=yes','ProtectProc=invisible','ProcSubset=pid','PrivateDevices=yes','PrivateMounts=yes','RestrictNamespaces=yes','ProtectSystem=strict','ReadWritePaths=/data /tmp /var/tmp','KillMode=control-group','Restart=no','MemoryMax=4G','MemorySwapMax=0','TasksMax=128'])assert.ok(args.includes(property));
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

test('offline build refuses missing pins and privileged install identities before running a command',async()=>{
 await assert.rejects(verifyOfflineBundle('', ''));
 await assert.rejects(verifyOfflineBundle('/var/lib/circle-hub','a'.repeat(64)));
 assert.throws(()=>offlineBuildProgram({uid:0,net:1,root:2,mounts:[],commit:'a'.repeat(40),host:'192.0.2.1',port:1234,malicious:false}));
});
test('untrusted postinstall cannot reach the outbound sentinel or host paths and failed npm resources are removed',{
 skip:process.env.CIRCLE_HUB_TEST_ISOLATION_VM===undefined?'requires pinned offline synthetic bundle in an administrator-declared VM':false,
 timeout:2_400_000,
},async()=>{
 const own=await proveSyntheticIsolation('malicious-postinstall');
 for(const path of [own.root,own.build,'/run/netns/'+own.namespace])await assert.rejects(lstat(path));
 const account=await runCommand('/usr/bin/id',['-u',own.user],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeoutMs:5000});assert.notEqual(account.code,0);
});

test('bundle subtree mount rejection precedes manifest or asset reads',()=>{
 const before=parseMountInfo('1 0 8:1 / / rw - ext4 /dev/synthetic rw');
 const baseline=trustedRootMount(before), path='/var/tmp/chvm-offline-123456abcdef';
 const overlaid=parseMountInfo(`2 1 8:1 /synthetic-backup/database.dump ${path}/source.tar rw - ext4 /dev/synthetic rw`);
 let contentsRead=false;
 assert.throws(()=>{
   // Match the verifier's explicit pre-content boundary. A rejected mount cannot reach content work.
   sourceMountReceipt([...before,...overlaid],path,'/offline',baseline);
   contentsRead=true;
 });
 assert.equal(contentsRead,false);
});

test('independent preparation accepts fixed public tarballs and rejects private or unlocked sources',()=>{
 const item={resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')};
 assert.equal(publicLockedTarballs({lockfileVersion:3,packages:{'':{},'node_modules/example':item}}).length,1);
 for(const patch of [{resolved:'http://registry.npmjs.org/example.tgz'},{resolved:'https://private.invalid/example.tgz'},{resolved:'https://user:pass@registry.npmjs.org/example.tgz'},{integrity:''},{link:true}])assert.throws(()=>publicLockedTarballs({lockfileVersion:3,packages:{'node_modules/example':{...item,...patch}}}));
});
test('offline cache index hashes are repeatable despite acquisition timestamps',()=>{
 const line=(time:number)=>{const body=JSON.stringify({key:'make-fetch-happen:request-cache:https://registry.npmjs.org/example.tgz',integrity:'sha512-YQ==',size:1,time,metadata:{time,headers:{date:String(time)}}});return createHash('sha1').update(body).digest('hex')+'\t'+body;};
 assert.equal(stableCacheIndex(line(1)),stableCacheIndex(line(999)));
 assert.throws(()=>stableCacheIndex('bad\t{}'));
});

test('namespace and Hub program guards refuse root identities and non-synthetic destinations',()=>{
 assert.throws(()=>namespaceEscapeProgram({uid:0,net:1,root:2,outer:3,hostPath:'/var/tmp/chvm-host-123456abcdef/hidden',mounts:[]}));
 assert.throws(()=>namespaceEscapeProgram({uid:500,net:1,root:2,outer:3,hostPath:'/var/lib/circle-hub',mounts:[]}));
 assert.throws(()=>hubMigrationProgram({uid:0,net:1,root:2,address:'192.0.2.1'},[]));
 assert.throws(()=>hubMigrationProgram({uid:500,net:1,root:2,address:'198.51.100.1'},[]));
});

test('only the freshly created bounded tmpfs is admitted as a source-mount exception',()=>{
 const root=parseMountInfo('1 0 8:1 / / rw - ext4 /dev/synthetic rw'),baseline=trustedRootMount(root);
 const volume={device:'0:44',root:'/',target:'/var/tmp/chvm-123456abcdef/data',fs:'tmpfs'};
 assert.throws(()=>sourceMountReceipt([...root,volume],volume.target,'/data',baseline));
 assert.equal(sourceMountReceipt([...root,volume],volume.target,'/data',baseline,[volume]).device,'0:44');
 assert.throws(()=>sourceMountReceipt([...root,{...volume,root:'/production'}],volume.target,'/data',baseline,[volume]));
});

test('sparse logical output cannot bypass the bounded build volume during privileged copy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chvm-size-'));
 try{const file=join(root,'sparse');await writeFile(file,'');await truncate(file,2048);await assert.rejects(assertBuiltTreeBudget(root,1024,10));}
 finally{await rm(root,{recursive:true});}
});
