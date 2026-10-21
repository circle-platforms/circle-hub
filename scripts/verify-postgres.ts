// CI check: boot a temporary PostgreSQL through the platform lifecycle (pinned binaries, socket only, peer
// authentication), run SELECT 1 as the application role, confirm there is no TCP listener and that the application role
// owns nothing, stop and clean up. The logic and its test are in hub/platform/verify.ts.
import { assertHubEnvironment } from '../hub/platform/environment.ts';
import { verifyPostgres } from '../hub/platform/verify.ts';

assertHubEnvironment(process.env);
const result = await verifyPostgres();
if (result.ok) {
  console.log(JSON.stringify({ ok: true, version: result.version, listen_addresses: result.listen_addresses, role: result.role, socket_only: true, synthetic: true }));
} else {
  console.error(JSON.stringify({ ok: false, message: result.message }));
  process.exitCode = 1;
}
