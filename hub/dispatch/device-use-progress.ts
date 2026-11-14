import {EffectBoundaryError,type DeviceUseProgress} from './boundary.ts';

/** Preserve earlier facts when only the next device request was refused. Counts are calls attempted, never remote verdicts. */
export function interruptedDeviceUse(error:EffectBoundaryError,current:DeviceUseProgress):EffectBoundaryError {
  if(error.failure.code!=='ENVIRONMENT_PERMISSION_UNAVAILABLE'&&error.failure.code!=='SOURCE_NOT_PERMITTED')return error;
  const prior=error.progress;
  if(prior&&!current.observations.length&&!current.help_results.length&&!current.attempts&&!current.sessions)return error;
  const observations=[...current.observations,...(prior?.observations??[])];
  const help_results=[...current.help_results,...(prior?.help_results??[])];
  const attempts=current.attempts+(prior?.attempts??0),sessions=current.sessions+(prior?.sessions??0);
  if(!observations.length&&!help_results.length&&!attempts&&!sessions)return error;
  const progress={observations,help_results,attempts,sessions};
  const references=[...new Set([...observations.map(row=>row.reference),...help_results.flatMap(row=>row.positions.flatMap(position=>[position.reference,...(position.text_reference?[position.text_reference]:[])])),...(error.failure.grounds??[])])];
  const fact=error.failure.code==='ENVIRONMENT_PERMISSION_UNAVAILABLE'
    ? '测试环境的权限核对现在不能进行，后续请求没有执行'
    : '后续设备请求的使用权限未成立，后续请求没有执行';
  const answers=help_results.reduce((count,row)=>count+row.positions.length,0);
  const message=fact+'；此前已保存 '+observations.length+' 项观察和 '+answers+' 项设备回答；中断设备段已尝试 '+attempts+' 次请求、建立 '+sessions+' 次会话。已有记录保留，先前请求的实际情况仍以原件为准'+(references.length>20?'；这里只列前 20 个原件引用，其余记录仍保留':'');
  return new EffectBoundaryError({...error.failure,message,fix:prior?error.failure.fix:error.failure.fix+'；先前尝试按原请求核对，不要盲目重试',...(references.length?{grounds:references.slice(0,20)}:{})},progress);
}
