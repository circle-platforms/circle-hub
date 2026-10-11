import type {Server} from 'node:http';

export const HTTP_SHUTDOWN_GRACE_MS=5_000;
// Outer supervisors must allow HTTP draining and database cleanup to finish.
export const SERVER_STOP_TIMEOUT_MS=HTTP_SHUTDOWN_GRACE_MS+5_000;
export const SUPERVISOR_STOP_TIMEOUT_MS=SERVER_STOP_TIMEOUT_MS+5_000;

export async function closeHttpServer(server:Server):Promise<void>{
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  // Connections active at close() may become idle later, or be reused by a poller.
  const idle=setInterval(()=>server.closeIdleConnections(),50);
  const deadline=setTimeout(()=>server.closeAllConnections(),HTTP_SHUTDOWN_GRACE_MS);
  server.closeIdleConnections();
  try{await closed;}finally{clearInterval(idle);clearTimeout(deadline);}
}
