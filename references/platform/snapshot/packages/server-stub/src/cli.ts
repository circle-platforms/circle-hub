import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CLI_EXIT_CODES } from "@infosec/contracts";
import { LongTaskService } from "./service.js";

/**
 * CLI transport for the stub:
 *   node cli.js <submit|status|result|input|cancel|reconcile> <envelope.json>
 * Prints the response envelope as JSON on stdout. The process exit code
 * is the frozen CLI mapping of the envelope status (FZ-01 / COM-06).
 *
 * State deliberately lives outside the process, in STUB_STATE_FILE:
 * each invocation loads and saves the service snapshot, the same way a
 * real CLI would talk to the state-owning service instead of keeping
 * task state in the client.
 */

const CALLS = ["submit", "status", "result", "input", "cancel", "reconcile"] as const;
type Call = (typeof CALLS)[number];

function main(): void {
  const [call, file] = process.argv.slice(2);
  if (!call || !file || !(CALLS as readonly string[]).includes(call)) {
    console.error(
      "usage: cli.js <submit|status|result|input|cancel|reconcile> <envelope.json>",
    );
    process.exit(64);
  }
  const stateFile = process.env.STUB_STATE_FILE;
  if (!stateFile) {
    console.error("STUB_STATE_FILE must point to the service state file");
    process.exit(64);
  }
  const service = existsSync(stateFile)
    ? LongTaskService.restore(JSON.parse(readFileSync(stateFile, "utf8")))
    : new LongTaskService();

  const envelope: unknown = JSON.parse(readFileSync(file, "utf8"));
  const response = service[call as Call](envelope);

  writeFileSync(stateFile, JSON.stringify(service.snapshot()));
  console.log(JSON.stringify(response));
  process.exit(CLI_EXIT_CODES[response.status]);
}

main();
