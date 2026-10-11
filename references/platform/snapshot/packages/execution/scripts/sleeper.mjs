// Sleeper: writes its pid to the pidfile, then sleeps. Used as the
// long-running subprocess whose life and death can be OBSERVED
// independently of any worker or control-plane claim.
import { writeFileSync } from "node:fs";

const [pidfile, msRaw] = process.argv.slice(2);
writeFileSync(pidfile, String(process.pid));
setTimeout(() => process.exit(0), Number(msRaw ?? "60000"));
