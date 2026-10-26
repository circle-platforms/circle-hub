import {feedingExamples} from './feeding-fixtures.ts';
// Shared model-owned interfaces; only synthetic raw sources and identities.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import * as S from '../generated/shared-interfaces.ts';
import {CLASSIFICATION_STATUS,COMMAND_PARSE_STATUS,JUDGMENT_STATUS,TYPE_DECLARATION_STATUS,QUALIFIER_MARK} from '../generated/vocabulary.ts';
const H='a'.repeat(64),src=`src:${H}`,rec=`rec:${H}`;
const quoteIdentity={source_sha256:H,parser:'text@1',path:'l/1',span:{unit:'byte',offset:0,length:9}};
const type={name:'U16',declaration:src,grammar:'synthetic-command@1',catalog_type:'int'};
const parameter={position:0,name:'count',type,raw:'7',parsed:{kind:'int',value:7}};
const command={tree_root:H,path:'/commands/synthetic/show',signature:src,parameters:[parameter]};
const producer={model_id:'synthetic-model-a',model_family_id:'synthetic-family-a'};
const claim={item:'case-a',category_id:'synthetic_category',quote:{identity:quoteIdentity,text:'合成原文'},producer};
const examples:Record<string,unknown[]>={
 ...feedingExamples(),
 'source-span@1':[quoteIdentity.span],
 'expected-quote-identity@1':[quoteIdentity],
 'quote-evidence@1':[claim.quote],
 'declared-parameter-type@1':[type],
 'declared-parameter-role@1':[{name:'synthetic_peer',declaration:src}],
 'typed-address-value@1':[{kind:'ipv4',value:'192.0.2.4'},{kind:'ipv6',value:'2001:db8::4'},{kind:'mask',value:'255.255.255.0'},{kind:'ipv4_prefix',value:24},{kind:'ipv6_prefix',value:64}],
 'parsed-parameter-value@1':[parameter.parsed,{kind:'address',value:{kind:'ipv4',value:'192.0.2.4'}},{kind:'boolean',value:true},{kind:'text',value:'synthetic'},{kind:'number',value:0.5}],
 'typed-parameter@1':[parameter],
 'command-identity@1':[command],
 'authored-category-fields@1':[{category_ids:['synthetic_category'],test_type_ids:['synthetic_type']},{category_ids:['synthetic_category']},{test_type_ids:['synthetic_type']},{}],
 'category-declaration@1':[{item:'case-a',reference:src,labels:{category_ids:['synthetic_category']}}],
 'model-identity@1':[producer],
 'category-judgment@1':[claim],
 'accepted-category-judgment@1':[{claim,accepted_result:rec}],
};
test('all model-owned shared interfaces publish matching closed Zod and JSON shapes',()=>{
 const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(S.SharedInterfaceSchemas),model.formatProposals.sharedInterfaces.definitions.map((d:any)=>d.id));
 const ajv=new AjvJsonSchemaValidator();
 for(const [id,schema] of Object.entries(S.SharedInterfaceSchemas)){
  const bodies=examples[id];assert.ok(bodies,id);
  const [name,version]=id.split('@');
  const json=JSON.parse(readFileSync(new URL(`../generated/schemas/${name}.v${version}.schema.json`,import.meta.url),'utf8'));
  const validate=ajv.getValidator(json);
  for(const body of bodies){assert.ok(schema.safeParse(body).success,id);assert.ok(validate(body).valid,id);if(typeof body==='object'&&body!==null){assert.equal(schema.safeParse({...body,unexpected:'x'}).success,false,id);assert.equal(validate({...body,unexpected:'x'}).valid,false,id);}}
 }
});
test('quote identity requires raw source, parser path and bounded original-byte span',()=>{
 for(const missing of ['source_sha256','parser','path','span']){const bad={...quoteIdentity};delete (bad as any)[missing];assert.equal(S.ExpectedQuoteIdentitySchema.safeParse(bad).success,false,missing);}
 for(const span of [{unit:'utf16',offset:0,length:9},{unit:'byte',offset:-1,length:9},{unit:'byte',offset:0,length:0},{unit:'byte',offset:0.5,length:9}])assert.equal(S.ExpectedQuoteIdentitySchema.safeParse({...quoteIdentity,span}).success,false);
 assert.notDeepEqual({...quoteIdentity,span:{...quoteIdentity.span,offset:1}},quoteIdentity,'same text at another byte span has a different identity');
});
test('complete command identity carries exact tree, signature and typed parse, never a text head alone',()=>{
 for(const missing of ['tree_root','path','signature','parameters']){const bad={...command};delete (bad as any)[missing];assert.equal(S.CommandIdentitySchema.safeParse(bad).success,false,missing);}
 assert.equal(S.TypedParameterSchema.safeParse({...parameter,type:undefined}).success,false);
 assert.equal(S.TypedParameterSchema.safeParse({...parameter,parsed:{kind:'int',value:'7'}}).success,false);
 assert.equal(S.DeclaredParameterTypeSchema.safeParse({...type,catalog_type:'guessed_type'}).success,false);
});
test('typed address forms cannot be selected by a bare numeric or address-looking string',()=>{
 for(const v of ['192.0.2.4',7,{kind:'ipv4',value:'999.1.1.1'},{kind:'ipv6',value:'192.0.2.4'},{kind:'ipv4_prefix',value:33},{kind:'ipv6_prefix',value:129}])assert.equal(S.TypedAddressValueSchema.safeParse(v).success,false);
});
test('author category fields stay distinct from model judgments and test-type declarations',()=>{
 const fields=S.AuthoredCategoryFieldsSchema.parse({category_ids:['functional'],test_type_ids:['Functional']});
 assert.deepEqual(fields,{category_ids:['functional'],test_type_ids:['Functional']},'shape does not alias case or map test types to categories; closed-set equality is checked against the bound pack');
 assert.equal(S.AuthoredCategoryFieldsSchema.safeParse({tags:['functional']}).success,false);
 assert.equal(S.CategoryJudgmentSchema.safeParse({item:'case-a',category_id:'x'}).success,false);
 assert.equal(S.AcceptedCategoryJudgmentSchema.safeParse({claim,accepted_result:src}).success,false);
 assert.equal(S.ModelIdentitySchema.safeParse({model_id:'synthetic-model-a'}).success,false);
});
test('shared interfaces reuse the existing generated evidence states and qualifier marks',()=>{
 assert.ok(CLASSIFICATION_STATUS.includes('unclassified'));assert.ok(JUDGMENT_STATUS.includes('unjudged'));
 assert.ok(TYPE_DECLARATION_STATUS.includes('undeclared'));assert.ok(COMMAND_PARSE_STATUS.includes('parameters_unchecked'));
 assert.ok(QUALIFIER_MARK.includes('legacy_keyword_rules'));assert.ok(QUALIFIER_MARK.includes('possible_credentials'));
});
