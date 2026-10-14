export interface Runner {name:string;run:()=>Promise<void>}

// Runners keep their own transactions. One failed runner must not suppress
// independent task, governance, automation or secret-maintenance work.
export async function runRunnerCycle(runners:readonly Runner[],report:(name:string,error:unknown)=>void):Promise<void>{
 for(const runner of runners){try{await runner.run();}catch(error){try{report(runner.name,error);}catch{/* A diagnostic sink also cannot starve later runners. */}}}
}
