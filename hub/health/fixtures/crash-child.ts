// A process that dies the way the Hub did: one request running, one finished, then the JavaScript heap runs out.
// Run with a small --max-old-space-size and the service's report flags by lifecycle.test.ts.
import { createRequestLog } from '../inflight.ts';

const [directory, boot] = process.argv.slice(2);
const log = createRequestLog({ directory: directory!, boot: boot!, now: () => new Date() });
log.begin({ traceId: null, origin: 'console', name: 'GET /console/finished', userId: null })();
const running = log.begin({ traceId: 'e'.repeat(32), origin: 'mcp', name: 'POST /mcp', userId: null });
running.identify({ userId: 'usr_synthetic', name: 'get_nodes' });
const keep: unknown[] = [];
for (;;) keep.push(new Array(100_000).fill({ held: true }));
