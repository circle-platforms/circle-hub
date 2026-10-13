import ExcelJS from 'exceljs';
import {zipSync} from 'fflate';
import {boundedUnzip} from '../../../packages/knowledge/src/zip.ts';
import {ApiError,MAX_SOURCE_BYTES,requireCondition,sha256} from '../../../packages/contracts/src/index.ts';
import {frameworkArguments,shellHost} from './dialect.ts';
import type {FunctionContract} from './function-contract.ts';

export interface ExecutionStep {row:number;type:number;description:string;object:string;method:string;data:string;commands:string[];saveAs?:string;inputRegister?:string;call?:{command:string;kwargs:Record<string,string|number>}}
export interface ExecutionCase {autoid:string;steps:ExecutionStep[]}
export interface ExecutionBook {sha256:string;cases:ExecutionCase[];initialization:ExecutionStep[];commands:{autoid:string|null;row:number;object:string;deviceIndex:number;command:string}[];hostCommands:{autoid:string|null;row:number;object:string;method:string;host:string;command:string;kwargs:Record<string,string|number>}[]}
const headers=['自动化ID','优先级','语句类型','描述','测试对象','方法','数据','临时保存期望结果','输入变量'];
export async function readExecutionWorkbook(bytes:Buffer,functions?:FunctionContract):Promise<ExecutionBook>{
  let location:{row:number|null;autoid:string|null;object:string|null;method:string|null}={row:null,autoid:null,object:null,method:null};
  const invalid=(message:string,details:Record<string,unknown>={})=>new ApiError('INVALID_EXECUTION_WORKBOOK',message,{...location,...details});
  try{
    requireCondition(bytes.length>0&&bytes.length<=MAX_SOURCE_BYTES,'INVALID_EXECUTION_WORKBOOK','Execution workbook exceeds the input limit');
    const entries=boundedUnzip(bytes),normalized=Buffer.from(zipSync(entries));
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(normalized as any);
    if(workbook.worksheets.length!==1||workbook.worksheets[0].name!=='执行')throw invalid('Use the single execution sheet contract');
    const sheet=workbook.worksheets[0];if(sheet.getRow(1).hidden!==true||sheet.getCell('A1').value!=='APV_EXCEL_CONTRACT | apv.excel.runtime | v1')throw invalid('The execution marker must be exact and row one hidden',{row:1});
    if(sheet.rowCount>50000||sheet.columnCount>9)throw invalid('Workbook row or column bound exceeded');
    const literal=(row:number,col:number)=>{const cell=sheet.getCell(row,col).value;return typeof cell==='string'||typeof cell==='number'?String(cell):null;};
    const value=(row:number,col:number)=>{const cell=sheet.getCell(row,col).value;if(cell===null)return '';if(typeof cell!=='string'&&typeof cell!=='number')throw invalid('Execution cells must be literal strings or numbers',{row,column:col});return String(cell);};
    let header=0;for(let row=2;row<=Math.min(sheet.rowCount,100);row++)if(headers.every((text,index)=>value(row,index+1)===text)){header=row;break;}if(!header)throw invalid('Execution columns are missing or reordered');
    const cases:ExecutionCase[]=[],initialization:ExecutionStep[]=[],commands:ExecutionBook['commands']=[],hostCommands:ExecutionBook['hostCommands']=[];let current:ExecutionCase|undefined,sentinel=false;
    for(let row=header+1;row<=sheet.rowCount;row++){
      location={row,autoid:Number(literal(row,3))===1?null:literal(row,1)||current?.autoid||null,object:literal(row,5)||null,method:literal(row,6)||null};
      const cells=Array.from({length:9},(_,i)=>value(row,i+1));if(cells.every(value=>value===''))continue;
      if(cells[0]==='999999999999999'){sentinel=true;current=undefined;continue;}if(sentinel)throw invalid('The sentinel must follow every executable case');
      const type=Number(cells[2]);if(cells[2]===''||!Number.isInteger(type)||type<0)throw invalid('Every execution row needs a numeric statement type');
      if(type===1)location.autoid=null;
      if(type===0)continue;
      if(type>=2&&cells[0]){if(!/^\d{1,32}$/.test(cells[0])||cases.some(item=>item.autoid===cells[0]))throw invalid('Case identities must be unique numeric strings');current={autoid:cells[0],steps:[]};cases.push(current);}
      if(type>=2&&!current)throw invalid('A step has no case identity');
      const step:ExecutionStep={row,type,description:cells[3],object:cells[4],method:cells[5],data:cells[6],commands:[],...(cells[7]?{saveAs:cells[7]}:{}),...(cells[8]?{inputRegister:cells[8]}:{})};
      if(functions&&step.object!=='test_env'&&(step.object||step.method||step.data)&&functions.status(step.object,step.method)!=='enabled')throw invalid('Execution function is not enabled in the bound function contract',{functionStatus:functions.status(step.object,step.method)});
      const device=/^(?:APV_(\d+)|Seg(\d+)_tmp)$/.exec(step.object);
      if(device){
        if(!['cmd','cmd_config','cmds_config','cmd_enable'].includes(step.method)||cells[8]!==''||/\b(?:Reg|Seg)\d+_tmp\b|\$\{/.test(step.data))throw invalid('Device rows need literal command methods without runtime input substitution; expand fuzzy execute and disabled helpers first');
        step.call=frameworkArguments(step.method==='cmd_config'?step.data.replace(/[\r\n]/g,''):step.data);step.commands=step.method==='cmds_config'?step.call.command.split(/\r?\n/).filter(command=>command.trim()!==''):[step.call.command];
        if(!step.commands.length||step.commands.some(command=>!command.trim()||command.length>2000||/[\x00-\x08\x0b-\x1f]/.test(command)))throw invalid('Device command is empty or outside the contract bounds');
        for(const command of step.commands)commands.push({autoid:type===1?null:current!.autoid,row,object:step.object,deviceIndex:Number(device[1]??device[2]),command});
      }else if(step.object==='test_env'||shellHost(step.object)){
        const host=step.object==='test_env'?step.method:step.object;
        if(!/^[a-z][a-z0-9_]{0,63}$/.test(host)||step.object!=='test_env'&&step.method!=='cmd'||!step.data.trim()||step.data.length>16384||cells[8]!==''||/[\x00-\x08\x0b-\x1f]/.test(step.data))throw invalid('Host dispatch needs an enabled literal method; lifecycle, reboot, console without role evidence and input-register substitution are not supported');
        step.call=frameworkArguments(step.data);hostCommands.push({autoid:type===1?null:current!.autoid,row,object:step.object,method:step.method,host,command:step.call.command,kwargs:step.call.kwargs});
      }else if(step.object==='check_point'){
        if(!['found','not_found','abs_found','found_times'].includes(step.method))throw invalid('Checkpoint method is outside the supported execution contract');
      }else if(step.object==='time'&&step.method==='sleep'){
        if(!Number.isFinite(Number(step.data))||Number(step.data)<0||Number(step.data)>3600)throw invalid('Sleep duration is outside the execution bounds');
      }else if(step.object||step.method||step.data)throw invalid('Opaque execution rows cannot prove every device command against the bound build');
      if(commands.length+hostCommands.length>5000)throw invalid('Execution command count exceeds the bounded validation limit');
      if(type===1)initialization.push(step);else current!.steps.push(step);
    }
    location={row:null,autoid:null,object:null,method:null};
    if(!cases.length||(!commands.length&&!hostCommands.length))throw invalid('An execution workbook needs real cases and literal dispatch commands');
    const missing=cases.find(item=>!item.steps.some(step=>step.object==='check_point'));if(missing){const step=missing.steps[0];throw invalid('Every case needs an explicit checkpoint',{row:step?.row??null,autoid:missing.autoid,object:step?.object??null,method:step?.method??null});}
    return {sha256:sha256(bytes),cases,initialization,commands,hostCommands};
  }catch(error){if(error instanceof ApiError){if(error.code==='INVALID_EXECUTION_WORKBOOK')throw invalid(error.message,error.details);throw error;}throw invalid('Workbook could not be read as the execution contract');}
}
