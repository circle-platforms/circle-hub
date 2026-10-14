// PostgreSQL JSONB rejects NUL. Originals remain in content-addressed storage;
// only the projected tool result is sanitized and explicitly marked.
export function sanitizeResult(value:any):any{
  let nulBytes=0;
  const visit=(item:any):any=>{
    if(typeof item==='string'){const count=item.split('\u0000').length-1;nulBytes+=count;return count?item.replaceAll('\u0000',''):item;}
    if(Array.isArray(item))return item.map(visit);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,value])=>[key,visit(value)]));
    return item;
  };
  const result=visit(value);return nulBytes?{...result,sanitized:true,nulBytes}:result;
}
