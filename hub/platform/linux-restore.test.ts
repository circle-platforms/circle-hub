import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {createBackup} from './backup.ts';
import {runPlatformCommand} from './cli.ts';
import {createContext, postgresFor} from './context.ts';
import {ensureLayout, layoutAt} from './layout.ts';
import {createPostgres, ensureDatabaseRunning} from './postgres.ts';
import {newSettingsFile, writeSettingsFile} from './settings.ts';
import {withSession} from './sql.ts';
import {captureIo, freePort, libpqAvailable, LIBPQ_MISSING, ok, ownerTables, recordingRunner, removeDir, socketPort, tempDir} from './test-support.ts';

const libpq = await libpqAvailable();
test('Linux restore bootstraps an empty root directly from a verified synthetic backup', {skip: !libpq ? LIBPQ_MISSING : process.platform !== 'linux' ? 'requires Linux PostgreSQL restore' : false}, async () => {
  const parent=await tempDir();const sourceLayout=layoutAt(join(parent,'src'));const targetLayout=layoutAt(join(parent,'dst'));const dbPort=socketPort();
  const source=createPostgres({layout:sourceLayout,port:dbPort});
  const runner=recordingRunner(call=>call.command==='/usr/bin/systemctl' ? ok('LoadState=not-found\n') : undefined);
  const env={CIRCLE_HUB_DATA_DIR:targetLayout.root};
  const target=createContext(env,{layout:targetLayout,platform:'linux',home:parent,runner:runner.runner,libpqBin:libpq,database:{name:'circle_hub',role:'circle_hub',port:dbPort}});
  try {
    await ensureLayout(sourceLayout);await writeSettingsFile(sourceLayout,newSettingsFile({environment:'test',port:await freePort(),database:{port:dbPort}}));
    await source.initialise();await ensureDatabaseRunning(source,{create:true});
    await ownerTables(source,['CREATE TABLE synthetic_restore (id integer PRIMARY KEY, value text)'],['synthetic_restore']);
    await withSession(source.connector,source.target.database,s=>s.query("INSERT INTO synthetic_restore VALUES (1,'synthetic')"));
    const backup=await createBackup({layout:sourceLayout,postgres:source,libpqBin:libpq});await source.stop();
    const captured=captureIo(env,parent);
    assert.equal(await runPlatformCommand(['restore',backup.dir],captured.io,target),0,captured.err.join('\n'));
    const restored=postgresFor(target);
    const rows=await withSession(restored.connector,restored.target.database,s=>s.query('SELECT id,value FROM synthetic_restore'));
    assert.deepEqual(rows,[{id:1,value:'synthetic'}]);
    assert.equal(runner.calls.some(call=>call.command==='/usr/bin/security'||call.command==='/bin/launchctl'),false);
  } finally {
    await source.stop().catch(()=>{});await postgresFor(target).stop().catch(()=>{});await removeDir(parent);
  }
});
