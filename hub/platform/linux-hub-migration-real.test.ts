// The real release/Hub/PG chain can run only after protection probes and unprivileged offline ci succeed.
import {test} from 'node:test';
import {proveSyntheticIsolation} from './testing/linux-rehearsal-isolation.ts';
test('real Hub synthetic cross-root migration stays inside the proved administrator VM enclosure',{
 skip:process.env.CIRCLE_HUB_TEST_ISOLATION_VM===undefined?'requires explicit administrator VM opt-in and independently prepared offline bundle':false,
 timeout:3_600_000,
},async()=>{await proveSyntheticIsolation('malicious-postinstall');await proveSyntheticIsolation('hub-migration');});
