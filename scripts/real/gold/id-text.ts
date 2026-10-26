// Independent numeric identity rules from FAMX's published text contract; no Hub or pack runtime imports.
/** Comparison key only: extraction separately rejects all-zero runs and checks their written lengths. */
export const idKey = (raw: string): string => raw.replace(/^0+(?=[0-9])/, '');

/** Read a whole digit run, keeping its original zero padding, never a truncated prefix. */
export function rawIdAt(text: string, at: number, min: number, max: number): {id:string;end:number} | null {
  let end=at;
  while(end<text.length && text[end]>='0' && text[end]<='9')end++;
  const id=text.slice(at,end);
  if(id.length<min || id.length>max || /^0+$/.test(id))return null;
  const before=text[at-1]??'', next=text[end]??'', after=text[end+1]??'';
  if(/[0-9]/.test(before) || before==='.' && /[0-9]/.test(text[at-2]??''))return null;
  if(next==='.' && /[0-9]/.test(after))return null;
  if(id.length<=4 && (next==='/' || next===':') && /[0-9]/.test(after))return null;
  if(id.length===4 && next==='-' && /^[0-9]{1,2}(?:[^0-9]|$)/.test(text.slice(end+1,end+4)))return null;
  if(id.length<=4 && /[A-Za-z]/.test(next))return null;
  if(id.length===8){
    const year=Number(id.slice(0,4)),month=Number(id.slice(4,6)),day=Number(id.slice(6,8));
    const date=new Date(Date.UTC(year,month-1,day));
    if(year>=1900 && year<=2999 && date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day)return null;
  }
  return {id,end};
}
