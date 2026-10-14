import type {Store} from '../../storage/src/index.ts';
import type {PrivateVault} from '../../assets/src/vault.ts';
export class ExecutionSecrets{
  store:Store;vault:PrivateVault;runSecrets:Map<string,{token:string;digest:string}>;last=0;
  constructor(store:Store,vault:PrivateVault,runSecrets:Map<string,{token:string;digest:string}>){this.store=store;this.vault=vault;this.runSecrets=runSecrets;}
  async tick(){if(Date.now()-this.last<1000)return;this.last=Date.now();await this.store.transaction(async tx=>{
    const injections=(await tx.query(`SELECT i.* FROM tool_injections i JOIN operations o USING(operation_id) WHERE o.status<>'running' OR o.deadline_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM leases l WHERE l.operation_id=o.operation_id AND l.fencing_token=o.fencing_token AND l.expires_at>clock_timestamp()) LIMIT 100 FOR UPDATE OF i SKIP LOCKED`)).rows;
    for(const row of injections){await this.vault.remove(row.secret_key);await tx.query('DELETE FROM tool_injections WHERE operation_id=$1',[row.operation_id]);}
    const resources=(await tx.query(`SELECT r.* FROM resource_access_tokens r JOIN service_clients c USING(client_id) LEFT JOIN operations o USING(operation_id) WHERE r.secret_key IS NOT NULL AND (r.expires_at<=clock_timestamp() OR c.revoked OR c.secret_version<>r.secret_version OR o.status<>'running' OR NOT EXISTS(SELECT 1 FROM leases l WHERE l.operation_id=o.operation_id AND l.fencing_token=r.fencing_token AND l.expires_at>clock_timestamp())) LIMIT 100 FOR UPDATE OF r SKIP LOCKED`)).rows;
    for(const row of resources){await this.vault.remove(row.secret_key);await tx.query('UPDATE resource_access_tokens SET secret_key=NULL,secret_binding=NULL WHERE digest=$1',[row.digest]);}
    const digests=[...this.runSecrets.values()].map(secret=>secret.digest);if(digests.length){const live=new Set((await tx.query(`SELECT a.digest FROM auth_tokens a WHERE a.digest=ANY($1::text[]) AND a.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM operations o JOIN leases l USING(operation_id) JOIN tasks t USING(task_id) WHERE o.operation_id=a.constraints->>'operationId' AND o.status='running' AND o.fencing_token=(a.constraints->>'fencingToken')::bigint AND l.fencing_token=o.fencing_token AND l.expires_at>clock_timestamp() AND t.phase NOT IN ('failed','delivered','unknown','cancelled') AND NOT t.cancel_requested)`,[digests])).rows.map(row=>row.digest));for(const [key,secret]of this.runSecrets)if(!live.has(secret.digest)){await tx.query('DELETE FROM auth_tokens WHERE digest=$1',[secret.digest]);this.runSecrets.delete(key);}}
  });}
}
