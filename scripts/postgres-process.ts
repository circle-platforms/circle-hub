import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// Give embedded-postgres its own supervised process. Its async signal hook then
// owns only PostgreSQL, and cannot exit the stack before worker/server cleanup.
const config = JSON.parse(process.env.CIRCLE_SERVER_DATABASE_CONFIG!);
const postgres = new EmbeddedPostgres({ databaseDir:process.env.CIRCLE_SERVER_PG_DIR!,user:config.user,password:config.password,
  port:config.port,persistent:false,createPostgresUser:false,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],
  onLog:() => {},onError:() => {} });
process.once('disconnect',() => { process.kill(process.pid,'SIGTERM'); });
try {
  await postgres.initialise(); await postgres.start();
  const client = new pg.Client(config); await client.connect();
  let version: string;
  try { version = (await client.query('SELECT version() AS version')).rows[0].version; } finally { await client.end(); }
  console.log(JSON.stringify({ type:'postgres-ready',version }));
} catch (error) {
  console.error(JSON.stringify({ type:'postgres-startup-failed',message:error instanceof Error ? error.message : 'Embedded PostgreSQL did not start' }));
  process.exitCode = 1; await postgres.stop(); if (process.connected) process.disconnect();
}
