export function environmentBuild(environment:any,expectedBuild:string){
  const check=environment?.checks?.find((item:any)=>item.check==='device_build'),detail=typeof check?.detail==='string'?/^device reports (.+), gateway bundle is (.+)$/.exec(check.detail):null,observedBuild=typeof environment?.observedBuild==='string'?environment.observedBuild:detail?.[1]??null;
  return {ruleId:'observed-device-build',ruleVersion:'1.0.0',expectedBuild,observedBuild,passed:environment?.ready===true&&environment?.build_checked===true&&check?.ok===true&&observedBuild===expectedBuild};
}
