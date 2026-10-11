import {ConnectorManifest,STANDARD_OPERATIONS,canonicalHash,requireCondition,type AuthContext,type Policy} from '../../contracts/src/index.ts';
import {CONNECTOR_MANIFESTS} from '../../connectors/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from './auth.ts';

export class ConnectorRegistry {
  store:Store;auth:Auth;
  constructor(store:Store,auth:Auth){this.store=store;this.auth=auth;}
  async initialize():Promise<void>{await this.store.transaction(async tx=>{
    const scopes=(await tx.query('SELECT DISTINCT tenant_id,jsonb_array_elements_text(scopes) AS scope_id FROM policies WHERE NOT disabled')).rows;
    for(const scope of scopes)for(const manifest of CONNECTOR_MANIFESTS)await tx.query('INSERT INTO connectors(tenant_id,scope_id,connector_id,manifest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenant_id,scope.scope_id,manifest.id,JSON.stringify(manifest)]);
  });}
  async effective(actor:AuthContext,ownerId?:string,tx?:Transaction):Promise<Policy>{
    const policy=await this.auth.policy(actor,tx);
    if(policy.kind!=='service')return policy;
    requireCondition(ownerId,'FORBIDDEN_ACTION','Service connector access needs an owned rule delegation');return this.auth.intersectService(policy.principalId,ownerId,tx);
  }
  async check(tx:Transaction,actor:AuthContext,scopeId:string,spec:any):Promise<any>{
    const policy=await this.effective(actor,spec.delegatedOwnerId,tx),target=spec.target;
    requireCondition(policy.scopes.includes(scopeId)&&policy.targets.includes(target)&&policy.grants.includes(spec.name),'FORBIDDEN_ACTION','Operation exceeds effective owner/service permissions');
    if(target==='LBX-LAB-01')return {principalId:policy.principalId,defects:policy.defects};
    const row=(await tx.query('SELECT * FROM connectors WHERE tenant_id=$1 AND scope_id=$2 AND connector_id=$3',[policy.tenantId,scopeId,target])).rows[0];
    requireCondition(row,'TARGET_NOT_FOUND','Connector binding not found');requireCondition(row.enabled,'CONNECTOR_DISABLED','Connector is disabled');
    const manifest=ConnectorManifest.parse(row.manifest),declared=manifest.operations.find(item=>item.name===spec.name);
    requireCondition(declared&&canonicalHash(declared.effects)===canonicalHash(STANDARD_OPERATIONS[spec.name as keyof typeof STANDARD_OPERATIONS]),'INVALID_PAYLOAD','No consistent effect declaration');
    const args=spec.args??{};if(args.defectId)requireCondition(policy.defects.includes(args.defectId),'FORBIDDEN_TARGET','Defect exceeds the rule owner visibility');
    return {principalId:policy.principalId,tenantId:policy.tenantId,defects:policy.defects,manifest};
  }
}
