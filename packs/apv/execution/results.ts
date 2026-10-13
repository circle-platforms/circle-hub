import type {ExecutionBook,ExecutionStep} from './workbook.ts';
import {isHostToken} from './dialect.ts';
import {environmentDevices,deviceAddress,type DeviceAttribution} from './environment.ts';

// Only explicit framework checkpoint lines establish a step verdict. Case verdicts
// and session replay are kept separate from these observations.
export function executionResults(book:ExecutionBook,raw:any,attribution:DeviceAttribution={}){
  const devices=environmentDevices(attribution);
  const unmapped:{path:string;reason:string}[]=[],linesFor=(log:string)=>log.split(/\r?\n/).map(line=>line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s?/,'') );
  const cases=book.cases.map(item=>{
    const observations=(Array.isArray(raw.cases)?raw.cases:[]).filter((row:any)=>row.case_id===item.autoid),observed=observations.length===1?observations[0]:null;
    const lines=linesFor(typeof observed?.log==='string'?observed.log:''),checks:any[]=[];
    const boundary=(line:string)=>/^(?:#{4,}|\S+ executes command|\S+ - sends command)/.test(line);
    for(let i=0;i<lines.length;i++){
      const head=/^#### (Success|Fail) Num (\d+): (successed|fail) to find (?!:)(.*)$/.exec(lines[i]);if(!head)continue;
      const start=i,pattern=[head[4]];let closed=/\s+in\s*:\s*$/.test(pattern.at(-1)!);
      while(!closed&&i+1<lines.length&&!boundary(lines[i+1])){pattern.push(lines[++i]);closed=/\s+in\s*:\s*$/.test(pattern.at(-1)!);}
      if(!closed){unmapped.push({path:`cases/${item.autoid}/log/${start+1}`,reason:'checkpoint_frame_unterminated'});continue;}
      pattern[pattern.length-1]=pattern.at(-1)!.replace(/\s+in\s*:\s*$/,'');const output:string[]=[];
      while(i+1<lines.length&&!boundary(lines[i+1]))output.push(lines[++i]);
      const passed=head[1]==='Success',method=(head[3]==='successed')===passed?'found':'not_found';checks.push({method,status:passed?'passed':'failed',pattern:pattern.join('\n'),output,logSpan:{startLine:start+1,endLine:i+1}});
    }
    const expected=item.steps.filter(step=>step.object==='check_point'),usable=observed&&!observed.log_stale&&observations.length===1&&checks.length===expected.length;
    if(!usable)unmapped.push({path:`cases/${item.autoid}`,reason:observed?.log_stale?'stale_log':`checkpoint_count_or_case_identity_mismatch:${checks.length}/${expected.length}`});
    const checkPoints=expected.map((step,index)=>{
      const check=checks[index],matches=usable&&check&&check.method===(step.method==='abs_found'?'found':step.method)&&check.pattern===step.data;
      if(!matches)unmapped.push({path:`cases/${item.autoid}/rows/${step.row}`,reason:'checkpoint_unmapped'});
      return {row:step.row,method:step.method,expected:step.data,...(matches?check:{status:'unknown',logSpan:null})};
    });
    const commandLines=lines.flatMap((line,index)=>{const match=/^(\S+) - sends command in (?:config|enable): (.*)$/.exec(line);return match?[{host:deviceAddress(match[1]),command:match[2],line:index+1}]:[];}),deviceCursors=new Map<number,number>();
    const steps=item.steps.map(step=>{
      const checkpoint=checkPoints.find(check=>check.row===step.row);if(checkpoint)return {...step,...checkpoint};
      if(step.object==='test_env'||isHostToken(step.object)){
        const host=step.object==='test_env'?step.method:step.object,command=(step.call?.command??step.data).split(/\r?\n/),matches=lines.flatMap((line,index)=>{const dispatch=/^(\S+) executes command: (.*)$/.exec(line);return dispatch&&dispatch[1].toLowerCase()===host&&dispatch[2]===command[0]&&command.slice(1).every((part,offset)=>lines[index+1+offset]===part)?[{startLine:index+1,endLine:index+command.length}]:[];});
        const unique=item.steps.filter(row=>row.object===step.object&&row.method===step.method&&row.data===step.data).length===1,observedDispatch=observed&&!observed.log_stale&&unique&&matches.length===1;
        if(!observedDispatch)unmapped.push({path:`cases/${item.autoid}/rows/${step.row}`,reason:'host_dispatch_not_proven'});return {...step,status:observedDispatch?'observed':'unknown',logSpans:observedDispatch?matches:[]};
      }
      if(!step.commands.length)return {...step,status:'unknown',logSpans:[]};
      const index=Number(/^APV_(\d+)$/.exec(step.object)?.[1]??/^Seg(\d+)_tmp$/.exec(step.object)?.[1]),host=devices?.ips[index];
      if(!host){unmapped.push({path:`cases/${item.autoid}/rows/${step.row}`,reason:'device_map_unavailable'});return {...step,status:'unknown',logSpans:[]};}
      const ownLines=commandLines.filter(line=>line.host===host),spans:{startLine:number;endLine:number}[]=[],missingCommandIndexes:number[]=[];let cursor=deviceCursors.get(index)??0;
      for(const [ordinal,command] of step.commands.entries()){const position=ownLines.findIndex((line,at)=>at>=cursor&&line.command===command);if(position<0)missingCommandIndexes.push(ordinal);else{spans.push({startLine:ownLines[position].line,endLine:ownLines[position].line});cursor=position+1;}}
      deviceCursors.set(index,cursor);const usableCommands=observed&&!observed.log_stale&&!missingCommandIndexes.length;
      if(!usableCommands)unmapped.push({path:`cases/${item.autoid}/rows/${step.row}`,reason:'step_outcome_not_proven'});
      return {...step,status:usableCommands?'observed':'unknown',logSpans:observed&&!observed.log_stale?spans:[],...(missingCommandIndexes.length?{missingCommandIndexes}:{})};
    });
    const verdict=observed?.result?.toLowerCase()==='pass'?'pass':observed?.result?.toLowerCase()==='fail'?'fail':'unknown';
    return {autoid:item.autoid,verdict,logStale:Boolean(observed?.log_stale),steps,checkPoints};
  });
  for(const observed of Array.isArray(raw.cases)?raw.cases:[])if(!book.cases.some(item=>item.autoid===observed.case_id))unmapped.push({path:'cases',reason:'unexpected_case_identity'});
  return {executionStatus:raw.channel==='runner_lost'?'unknown':'completed',channel:raw.channel,rc:raw.rc??null,sourceSha256:book.sha256,cases,unmapped,modelJudgments:[],remoteStoppingVerified:false,deviceMap:devices?{source:devices.source,deviceCount:devices.ips.length}:null,parserVersion:'framework-checkpoints/2'};
}
