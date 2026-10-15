import type pg from 'pg';

// Pool.end can resolve before its clients emit end. Stop the owned PostgreSQL
// only after those sockets close; never hide a pool error during ordinary use.
export function closePoolSockets(pool:pg.Pool,timeoutMs=5000){
 const sockets=new Set<Promise<void>>();let closing:Promise<void>|undefined;
 const connected=(client:pg.PoolClient)=>{
  const ended=new Promise<void>(resolve=>client.once('end',resolve));
  sockets.add(ended);void ended.then(()=>sockets.delete(ended));
 };
 pool.on('connect',connected);
 return ()=>closing??=(async()=>{
  await pool.end();
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([Promise.all([...sockets]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Database client sockets did not close before PostgreSQL shutdown')),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);pool.removeListener('connect',connected);}
 })();
}
