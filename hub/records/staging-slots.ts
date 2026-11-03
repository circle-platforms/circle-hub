// Queued extraction/checks hold no database connection. Skip occupied owners so one member cannot block another.
export function stagingSlots(limit:number){
 const owners=new Set<string>(),waiting:{owner:string;run:()=>Promise<void>}[]=[];
 const pump=()=>{
  while(owners.size<limit){
   const next=waiting.findIndex(item=>!owners.has(item.owner));if(next<0)return;
   const item=waiting.splice(next,1)[0];owners.add(item.owner);
   void item.run().finally(()=>{owners.delete(item.owner);pump();});
  }
 };
 return <T>(owner:string,work:()=>Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  waiting.push({owner,run:async()=>{try{resolve(await work());}catch(error){reject(error);}}});pump();
 });
}
