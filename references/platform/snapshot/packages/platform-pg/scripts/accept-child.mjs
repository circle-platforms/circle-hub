// Crash-test child: performs the accept transaction against a real
// PostgreSQL, then either holds the transaction open (mode=hold) or
// commits it (mode=commit) and hangs, so the parent can SIGKILL it and
// observe what actually persisted.
import pg from "pg";

const [mode, connectionString, taskId, idemKey] = process.argv.slice(2);
const client = new pg.Client({ connectionString });
await client.connect();
await client.query("BEGIN");
await client.query(
  `INSERT INTO idempotency (principal_id, op_name, idem_key, request_hash, task_id)
   VALUES ('prn_alice', 'task.accept', $1, 'hash-crash', $2)`,
  [idemKey, taskId],
);
await client.query(
  `INSERT INTO tasks (task_id, tenant_id, scope_id, principal_id, title, phase, input_revision_id)
   VALUES ($1, 'tnt_main', 'scp_demo_a', 'prn_alice', 'crash test', 'admitted', 'rev_000001')`,
  [taskId],
);
if (mode === "commit") {
  await client.query("COMMIT");
  console.log("COMMITTED");
} else {
  console.log("READY");
}
setInterval(() => {}, 1000);
