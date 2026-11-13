import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertResetTarget } from './reset-target.ts';

const target = { socketDir: '/synthetic/socket', port: 5432, database: 'synthetic', user: 'owner' };
const database = { host: target.socketDir, port: target.port, database: target.database, user: 'runtime' };
test('reset accepts a distinct runtime role only for the same managed database', () => {
  assert.doesNotThrow(() => assertResetTarget(database, target));
});
test('reset refuses each mismatched database target before invoking platform operations', () => {
  for (const change of [{ host: '192.0.2.1' }, { port: 5433 }, { database: 'another' }])
    assert.throws(() => assertResetTarget({ ...database, ...change }, target), /未执行重置/);
});

import { resetOwnerDatabase } from './reset-configuration.ts';
import { createContext, layoutAt, postgresFor } from '../platform/api.ts';
import { DEFAULT_LIMITS, type HubConfig } from '../config/index.ts';
import { httpResetDefinitionAllowed } from './rebuild-http.ts';

test('offline apply selects the owner only for the exact managed transport', () => {
  const context=createContext({}, {layout:layoutAt('/synthetic'),user:'synthetic_owner',database:{name:'synthetic',role:'runtime',port:5432}});
  const target=postgresFor(context).target;
  const config:HubConfig={dataDir:'/synthetic',logDir:'/synthetic/logs',host:'127.0.0.1',port:0,limits:DEFAULT_LIMITS,
    database:{host:target.socketDir,port:target.port,database:target.database,user:'runtime'}};
  const result=resetOwnerDatabase(config,context);
  assert.deepEqual(result,{host:target.socketDir,port:target.port,database:target.database,user:target.user});
  assert.equal(config.database.user,'runtime');
  assert.throws(()=>resetOwnerDatabase({...config,database:{...config.database,database:'another'}},context),/未执行重置/);
});
test('network definitions accept only content-addressed src references, never local paths', () => {
  assert.equal(httpResetDefinitionAllowed(undefined),true);
  assert.equal(httpResetDefinitionAllowed('src:'+'a'.repeat(64)),true);
  for (const input of ['/synthetic/deployment.json','relative.json','file:///synthetic/deployment.json','https://example.invalid/definition','src:not-a-digest',null,{}])
    assert.equal(httpResetDefinitionAllowed(input),false);
});
