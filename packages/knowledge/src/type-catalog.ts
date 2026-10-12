import {ObjectTypePackage,canonicalHash,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';

export class TypeCatalog {
  store:Store;auth:Auth;
  constructor(store:Store,auth:Auth){this.store=store;this.auth=auth;}
  async register(ctx:AuthContext,input:ObjectTypePackage):Promise<any>{
    const definition=ObjectTypePackage.parse(input),digest=canonicalHash(definition);
    return this.store.transaction(async tx=>{
      const policy=await this.auth.check(ctx,'objects.manage',undefined,tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([policy.tenantId,definition.id,definition.version])]);
      const old=(await tx.query('SELECT * FROM object_type_packages WHERE tenant_id=$1 AND package_id=$2 AND version=$3',[policy.tenantId,definition.id,definition.version])).rows[0];
      requireCondition(!old||old.sha256===digest,'IDEMPOTENCY_MISMATCH','A published object vocabulary version is immutable');
      if(!old){
        await tx.query('INSERT INTO object_type_packages(tenant_id,package_id,version,sha256,definition,registered_by) VALUES($1,$2,$3,$4,$5,$6)',[policy.tenantId,definition.id,definition.version,digest,JSON.stringify(definition),policy.principalId]);
        await this.auth.audit(ctx,'object-types.register',{packageId:definition.id,version:definition.version,sha256:digest},undefined,tx);
      }
      return {...definition,sha256:digest,deduplicated:!!old};
    });
  }
  async list(ctx:AuthContext):Promise<any[]>{
    const policy=await this.auth.check(ctx,'objects.read');
    return (await this.store.pool.query('SELECT definition,sha256 FROM object_type_packages WHERE tenant_id=$1 ORDER BY package_id,version',[policy.tenantId])).rows.map(row=>({...row.definition,sha256:row.sha256}));
  }
  async validate(tenantId:string,ref:{packageId:string;version:string;typeId:string},attributes:Record<string,unknown>,tx:Transaction):Promise<void>{
    const row=(await tx.query('SELECT definition FROM object_type_packages WHERE tenant_id=$1 AND package_id=$2 AND version=$3',[tenantId,ref.packageId,ref.version])).rows[0];
    requireCondition(row,'TARGET_NOT_FOUND','Object vocabulary version is not registered');
    const type=ObjectTypePackage.parse(row.definition).types.find(type=>type.id===ref.typeId);
    requireCondition(type,'INVALID_PAYLOAD','Object type is not declared in its vocabulary');
    requireCondition(type.required.every(key=>Object.hasOwn(attributes,key)),'INVALID_PAYLOAD','Required object attributes are missing');
    for(const [key,value] of Object.entries(attributes)){
      const kind=type.attributes[key];
      const valid=kind==='any'||kind==='string'&&typeof value==='string'||kind==='number'&&typeof value==='number'&&Number.isFinite(value)
        ||kind==='boolean'&&typeof value==='boolean'||kind==='string[]'&&Array.isArray(value)&&value.every(item=>typeof item==='string')
        ||kind==='object'&&value!==null&&typeof value==='object'&&!Array.isArray(value);
      requireCondition(valid,'INVALID_PAYLOAD','Object attributes do not match the registered schema');
    }
  }
}
