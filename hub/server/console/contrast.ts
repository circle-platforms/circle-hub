// Token-based WCAG contrast audit. Test/tool use only; original colours remain owned by the shared design.
type RGBA=readonly [number,number,number,number];
interface Tokens {color:{tokens:{name:string;value:string|{dark:string;light:string}}[]}}
export interface ContrastSample {theme:string;role:string;foreground:RGBA;background:RGBA;ratio:number;required:number}
export const composite=(fg:RGBA,bg:RGBA):RGBA=>[fg[0]*fg[3]+bg[0]*(1-fg[3]),fg[1]*fg[3]+bg[1]*(1-fg[3]),fg[2]*fg[3]+bg[2]*(1-fg[3]),1];
const luminance=(c:RGBA)=>[.2126,.7152,.0722].reduce((sum,k,i)=>sum+k*(c[i]<=.04045?c[i]/12.92:((c[i]+.055)/1.055)**2.4),0);
export const contrast=(a:RGBA,b:RGBA)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
export function auditContrast(spec:Tokens):ContrastSample[]{
 const tokens=new Map(spec.color.tokens.map(token=>[token.name,token.value])),samples:ContrastSample[]=[];
 for(const theme of ['dark','light'] as const){
  const color=(name:string,seen=new Set<string>()):RGBA=>{
   if(seen.has(name))throw new Error('Cyclic colour '+name);seen.add(name);const token=tokens.get(name);if(!token)throw new Error('Missing colour '+name);
   const value=typeof token==='string'?token:token[theme],ref=/^\{([^}]+)\}$/.exec(value);if(ref)return color(ref[1],seen);
   if(/^#[0-9a-f]{6}$/i.test(value))return [parseInt(value.slice(1,3),16)/255,parseInt(value.slice(3,5),16)/255,parseInt(value.slice(5,7),16)/255,1];
   const rgba=/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(value.replaceAll(' ',''));if(rgba)return [Number(rgba[1])/255,Number(rgba[2])/255,Number(rgba[3])/255,Number(rgba[4])];
   throw new Error('Unsupported colour '+value);
  };
  const sample=(role:string,fg:RGBA,bg:RGBA,required=4.5)=>{const painted=composite(fg,bg);samples.push({theme,role,foreground:painted,background:bg,ratio:contrast(painted,bg),required});};
  const surfaces=['surface-0','surface-1','surface-2','surface-3','surface-sunken'];
  for(const name of surfaces){const base=color(name);
   for(const fg of ['text-primary','text-secondary','text-tertiary','text-link'])sample(name+'/'+fg,color(fg),base);
   sample(name+'/control',color('line-control'),base,3);sample(name+'/focus',color('focus-ring'),base,3);
   sample(name+'/danger/text',color('status-fail-text'),base);const danger=composite(color('status-fail-bg'),base);sample(name+'/danger-hover/text',color('status-fail-text'),danger);sample(name+'/danger-hover/edge',color('line-control'),danger,3);
   sample(name+'/primary/edge',color('inverse-surface'),base,3);
   const inverse=color('text-inverse'),solid=color('inverse-surface'),hover=composite([solid[0],solid[1],solid[2],.88],base),text=composite([inverse[0],inverse[1],inverse[2],.88],base);sample(name+'/primary-hover/text',text,hover);sample(name+'/primary-hover/edge',hover,base,3);
   for(const state of ['surface-hover','surface-pressed']){const bg=composite(color(state),base);sample(name+'/'+state+'/helper',color('text-secondary'),bg);sample(name+'/'+state+'/text',color('text-primary'),bg);sample(name+'/'+state+'/edge',color(state==='surface-pressed'?'focus-ring':'line-control'),bg,3);}
  }
  for(const name of ['surface-1','surface-2','surface-3']){const base=color(name);
   for(const state of spec.color.tokens.filter(token=>/^status-.+-bg$/.test(token.name)).map(token=>token.name.slice(7,-3))){const bg=composite(color('status-'+state+'-bg'),base);sample(name+'/badge-'+state,color('status-'+state+'-text'),bg);}
   for(const area of ['area-knowledge','area-workflow','area-task','text-secondary'])for(const opacity of [.08,.09]){
    const accent=color(area),selected=composite([accent[0],accent[1],accent[2],opacity],base),cell=selected;
    for(const state of ['selected','selected-hover'] as const){const bg=state==='selected'?cell:composite(color('surface-hover'),selected);sample(name+'/'+area+'/'+opacity+'/'+state+'/helper',color('text-secondary'),bg);sample(name+'/'+area+'/'+opacity+'/'+state+'/text',color('text-primary'),bg);sample(name+'/'+area+'/'+opacity+'/'+state+'/link',color('text-primary'),bg);}
   }
  }
  const main=color('surface-1');
  for(const name of ['chart-1','chart-2','chart-3','chart-4']){const fg=color(name);sample('chart/'+name,fg,main,3);sample('chart/'+name+'/hover-other',[fg[0],fg[1],fg[2],.9],main,3);sample('chart/'+name+'/loading',[fg[0],fg[1],fg[2],.9],main,3);}
  for(const name of ['status-pass','status-fail','status-warn','status-info','status-muted'])sample('parts/'+name,color(name),main,3);
  for(const name of ['text-primary','text-secondary','text-tertiary']){const fg=color(name);sample('loading/'+name,[fg[0],fg[1],fg[2],.9],main);}
  sample('primary/text',color('text-inverse'),color('inverse-surface'));
 }
 return samples;
}
