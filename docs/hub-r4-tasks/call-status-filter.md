# Make the call status and the read recovery work for users with many logged calls

On the production Hub a finished `get_nodes` could never be recovered by its trace: even a small read, queried right after it ended with the right arguments and trace, answered "the reply body was not kept". Cause: `callStatus` looked at the newest 500 log lines of the user's tool and filtered them in memory; a user with more than 500 lines always had a next page, so the status counted as truncated and the recovery (which requires a complete status) never ran. The same window also made older calls look "not found".

Change: the call log query takes `traceId` and `argsDigest` filters (a user still sees only their own lines), and `callStatus` asks for exactly the calls with these arguments (and this trace), so the answer is complete for them. Messages that spoke of "the newest 500 lines" now speak of matching lines.

Allowed paths: `hub/records/api.ts`, `hub/records/calllog.ts`, `hub/records/calllog.test.ts`, `hub/server/call-status.ts`, `hub/server/read-recovery-mcp.test.ts`, this page.

Verification: the new tests (filters; recovery for a user with 505 logged reads, which fails without the change), and `affected-tests.py --run` against hub-redesign (decision 80).
