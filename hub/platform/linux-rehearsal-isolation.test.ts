// Pure safety-contract negatives plus an opt-in root VM proof; never accepts a real backup or a key pipeline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isolatedUnitArguments, proveSyntheticIsolation, type IsolationDefinition} from './testing/linux-rehearsal-isolation.ts';
const fixture:IsolationDefinition={unit:'chvm-123456abcdef-probe',user:'chvm-123456abcdef',namespace:'chvm-123456abcdef',root:'/var/tmp/chvm-synthetic',data:'/var/tmp/chvm-synthetic/data',release:'/var/tmp/synthetic-release',node:'/usr/bin/node'};
test('isolated units require rootfs and netns plus capability and host-filesystem restrictions',()=>{
 const args=isolatedUnitArguments(fixture,['/runtime/node','/release/bin/circle-hub','serve']);
 for(const property of [`RootDirectory=${fixture.root}`,`NetworkNamespacePath=/run/netns/${fixture.namespace}`,'CapabilityBoundingSet=','NoNewPrivileges=yes','ProtectProc=invisible','ProcSubset=pid','PrivateDevices=yes','PrivateMounts=yes','RestrictNamespaces=yes','ProtectSystem=strict','ReadWritePaths=/data','KillMode=control-group','Restart=no'])assert.ok(args.includes(property));
 assert.ok(args.includes('User='+fixture.user));
 assert.ok(!args.some(arg=>arg.includes('BindPaths=/home')||arg.includes('BindPaths=/mnt')));
});
test('foreign identities, escaping paths, external roots and arbitrary executables are rejected',()=>{
 for(const patch of [{user:'root'},{namespace:'production'},{unit:'circle-hub'},{release:'/var/tmp/x:/home'},{root:'/var/tmp/../home'},{data:'/var/lib/circle-hub'}])assert.throws(()=>isolatedUnitArguments({...fixture,...patch},['/runtime/node','/release/bin/circle-hub']));
 assert.throws(()=>isolatedUnitArguments(fixture,['/bin/sh','-c','ignored']));
});
test('root-managed synthetic VM isolation establishes outbound denial and child inheritance',{
 skip:process.env.CIRCLE_HUB_TEST_ISOLATION_VM===undefined?'requires administrator-declared disposable VM and prepared synthetic release':false,
 timeout:300_000,
},async()=>{
 const release=process.env.CIRCLE_HUB_TEST_SYNTHETIC_RELEASE;
 assert.ok(release,'supply a freshly built synthetic release, never a production deployment');
 await proveSyntheticIsolation(release);
});
