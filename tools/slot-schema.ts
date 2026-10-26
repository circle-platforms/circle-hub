// Project an authoritative contract schema into the Hub's restricted slot-schema vocabulary.
// Identity and reference constraints stay on the authoritative admission boundary, not in pack-supplied regexes.
const maps=new Set(['properties','$defs','definitions','dependentSchemas']);
const one=new Set(['items','additionalItems','additionalProperties','unevaluatedItems','unevaluatedProperties','propertyNames','contains','not','if','then','else','contentSchema']);
const lists=new Set(['allOf','anyOf','oneOf','prefixItems']);
const unsupported=new Set(['pattern','patternProperties','format']);
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export function supportedSlotSchema(schema:unknown):unknown{
 if(!object(schema))return structuredClone(schema);
 return Object.fromEntries(Object.entries(schema).filter(([key])=>!unsupported.has(key)).map(([key,value])=>{
  if(maps.has(key)&&object(value))return [key,Object.fromEntries(Object.entries(value).map(([name,child])=>[name,supportedSlotSchema(child)]))];
  if(lists.has(key)&&Array.isArray(value))return [key,value.map(supportedSlotSchema)];
  if(one.has(key))return [key,Array.isArray(value)?value.map(supportedSlotSchema):supportedSlotSchema(value)];
  if(key==='dependencies'&&object(value))return [key,Object.fromEntries(Object.entries(value).map(([name,child])=>[name,Array.isArray(child)?structuredClone(child):supportedSlotSchema(child)]))];
  return [key,structuredClone(value)];
 }));
}
export function contributionSlots(schema:Record<string,any>,kinds:readonly {code:string;label:string}[]){
 const properties={...schema.properties};delete properties.kind;delete properties.statement;
 const data=supportedSlotSchema({type:'object',additionalProperties:false,required:['root','path','source'],properties}) as Record<string,any>&{properties:Record<string,any>};
 return {schema:'slots@1',item:{contribution:{min:1,max:1,codes:kinds.map(value=>({code:value.code,label:value.label})),data}},run:{}};
}
