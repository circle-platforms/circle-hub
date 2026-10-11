import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, HEARTBEAT_MS, WorkerClaim, sha256 } from '../../../packages/contracts/src/index.ts';
import { compileMindmap } from '../../../packages/methods/src/mindmap.ts';

function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const base = new URL(env('CIRCLE_SERVER_URL'));
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Phase one worker only connects to the authorized loopback development server');
const username = env('CIRCLE_WORKER_USERNAME'); const password = env('CIRCLE_WORKER_PASSWORD');
let token = ''; let expires = 0; let stopped = false;
process.on('SIGTERM', () => { stopped = true; }); process.on('SIGINT', () => { stopped = true; });
process.once('disconnect',() => { stopped = true; });
async function authenticate(): Promise<void> {
  if (token && Date.now() < expires - 5000) return;
  const response = await fetch(new URL('/v1/auth/dev-login',base), { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ username,password }) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError('UNAUTHENTICATED','Worker development login failed');
  token = envelope.data.token; expires = Date.parse(envelope.data.expiresAt);
}
async function request(path: string,body: unknown): Promise<any> {
  await authenticate();
  const response = await fetch(new URL(path,base), { method:'POST',headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' },body: JSON.stringify(body) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError(envelope.error.code,envelope.error.message);
  return envelope.data;
}
await request('/v1/workers/register',{});
console.log(JSON.stringify({ type:'worker-ready',username }));
while (!stopped) {
  try {
    const next = await request('/v1/workers/claim',{});
    if (!next) { await delay(100); continue; }
    const claim = WorkerClaim.parse(next); const fence = { fencingToken:claim.fencingToken };
    await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
    let heartbeatError: unknown; let pendingHeartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pendingHeartbeat) return;
      pendingHeartbeat = request(`/v1/workers/operations/${claim.operationId}/heartbeat`,fence).then(() => {}).catch(error => { heartbeatError = error; }).finally(() => { pendingHeartbeat = undefined; });
    },HEARTBEAT_MS);
    try {
      await authenticate();
      const response = await fetch(new URL(`/v1/workers/operations/${claim.operationId}/source?fence=${claim.fencingToken}`,base),{ headers:{ authorization:`Bearer ${token}` } });
      if (!response.ok) throw new ApiError('EVIDENCE_INSUFFICIENT','Source download failed');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== claim.source.sha256) throw new ApiError('SOURCE_HASH_MISMATCH','Worker source hash mismatch');
      // The executing process repeats live authorization immediately before computing/writing an artifact.
      await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
      let report;
      try {
        const compiled = await compileMindmap(bytes,claim.source.fileName);
        report = { ...fence,inputRevisionId:claim.inputRevisionId,status:compiled.status,artifactBase64:compiled.workbook.toString('base64') };
      } catch (error) {
        const failure = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR','Compiler failed');
        report = { ...fence,inputRevisionId:claim.inputRevisionId,status:'failed',error:{ code:failure.code,message:failure.message } };
      }
      if (heartbeatError) throw heartbeatError;
      await request(`/v1/workers/operations/${claim.operationId}/report`,report);
    } finally { clearInterval(timer); await pendingHeartbeat; }
  } catch (error) {
    console.error(JSON.stringify({ type:'worker-operation-error',code:error instanceof ApiError ? error.code : 'TRANSPORT_CLOSED' }));
    await delay(300);
  }
}
if (process.connected) process.disconnect();
