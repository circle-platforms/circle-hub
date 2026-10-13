import {ApiError} from '../../../packages/contracts/src/index.ts';

export const isHostToken=(name:string)=>/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(name)&&!['test_env','check_point','time'].includes(name)&&!/^(?:APV_\d+|Seg\d+_tmp)$/.test(name);
export function frameworkArguments(input:string):{command:string;kwargs:Record<string,string|number>}{
  const fail=(message:string):never=>{throw new ApiError('INVALID_EXECUTION_WORKBOOK',message);};
  if(input.includes('\n'))return {command:input,kwargs:{}};
  const parts:string[]=[];let current='',quote='',escaped=false;
  for(const char of input){
    if(escaped){current+=char;escaped=false;continue;}
    if(quote&&char==='\\'){current+=char;escaped=true;continue;}
    if(char===quote){quote='';current+=char;continue;}
    if(!quote&&(char==='"'||char==="'")){quote=char;current+=char;continue;}
    if(!quote&&char===','){if(current.trim())parts.push(current.trim());current='';continue;}current+=char;
  }
  if(quote)fail('Framework argument quotes are not balanced');if(current.trim())parts.push(current.trim());
  const positional:string[]=[],kwargs:Record<string,string|number>={};
  for(let part of parts){if(part.length>=2&&['"',"'"].includes(part[0])&&part.at(-1)===part[0])part=part.slice(1,-1).trim();
    const equal=part.indexOf('='),key=equal>=0?part.slice(0,equal).trim():'';
    if(equal<0||/\s/.test(key)){positional.push(part);continue;}
    if(!['prompt','timeout'].includes(key)||Object.hasOwn(kwargs,key))fail('Only one prompt and timeout keyword is supported');const value=part.slice(equal+1).trim();
    if(key==='timeout'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>3600)fail('Timeout must be an integer from one to 3600 seconds');kwargs[key]=Number(value);}
    else{if(!value||value.length>500)fail('Prompt is outside the literal argument bounds');kwargs[key]=/^\d+$/.test(value)?Number(value):value;}
  }
  if(positional.length!==1||!positional[0].trim())fail('A dispatch needs one literal command argument');return {command:positional[0],kwargs};
}
