import {requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';

export interface RuntimeBinding {assetId:string;version:string;sha256:string;profileSha256:string}
// A draft is the registry's newest submission, not live execution authority.
// Consumers resolving a new binding choose a revision with its own approval.
export async function approvedRuntimeRevision(store:Store,ctx:AuthContext,scope:string,type:string,ref:string,tx?:Transaction){
 return (await(tx??store.pool).query(`SELECT a.*,v.* FROM assets a JOIN asset_versions v USING(asset_id)
   WHERE a.tenant_id=$1 AND a.scope_id=$2 AND a.kind='runtime-profile'
   AND v.configuration->>'profileType'=$3 AND v.configuration->>'profileRef'=$4
   AND v.lifecycle IN ('approved','running') AND v.approved_digest=v.sha256
   ORDER BY v.created_at DESC,v.version DESC LIMIT 1`,[ctx.tenantId,scope,type,ref])).rows[0];
}
export async function boundRuntimeRevision(store:Store,ctx:AuthContext,scope:string,binding:RuntimeBinding,expectedDigest:string,tx?:Transaction){
 const row=(await(tx??store.pool).query(`SELECT a.*,v.* FROM assets a JOIN asset_versions v USING(asset_id)
   WHERE a.tenant_id=$1 AND a.scope_id=$2 AND a.asset_id=$3 AND a.kind='runtime-profile' AND v.version=$4`,[ctx.tenantId,scope,binding.assetId,binding.version])).rows[0];
 requireCondition(row&&row.sha256===binding.sha256&&row.approved_digest===row.sha256&&['approved','running'].includes(row.lifecycle)
   &&row.configuration.profileType==='runtime'&&row.configuration.profileRef==='circle-runtime'
   &&binding.profileSha256===expectedDigest&&row.configuration.profileSha256===expectedDigest,'SOURCE_NOT_APPROVED','The frozen runtime profile is disabled or no longer matches the configured runtime');
 return row;
}
