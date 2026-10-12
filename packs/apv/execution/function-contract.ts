import {z} from 'zod';
import {ApiError} from '../../../packages/contracts/src/index.ts';
const state=z.enum(['enabled','disabled','internal']);
const shape=z.object({schema:z.literal('ist.excel.function-contract'),complete:z.literal(true),entries:z.array(z.object({e:z.string().min(1).max(200),f:z.string().min(1).max(200),status:state}).passthrough()).min(1).max(10000),objects:z.array(z.object({e:z.string().min(1).max(200),status:state}).passthrough()).max(1000).optional()}).passthrough();
export class FunctionContract{
  methods=new Map<string,string>();objects=new Map<string,string>();
  constructor(bytes:Buffer){
    let parsed:z.infer<typeof shape>;try{parsed=shape.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new ApiError('INVALID_PAYLOAD','Function contract must be complete JSON with e/f/status entries',{field:'function-contract'});}
    for(const entry of parsed.entries){const key=JSON.stringify([entry.e,entry.f]);if(this.methods.has(key))throw new ApiError('INVALID_PAYLOAD','Function contract contains duplicate method declarations',{field:'function-contract',object:entry.e,method:entry.f});this.methods.set(key,entry.status);}
    for(const entry of parsed.objects??[]){if(this.objects.has(entry.e))throw new ApiError('INVALID_PAYLOAD','Function contract contains duplicate object declarations',{field:'function-contract',object:entry.e});this.objects.set(entry.e,entry.status);}
  }
  status(object:string,method:string):string{const status=this.objects.get(object);return status&&status!=='enabled'?status:this.methods.get(JSON.stringify([object,method]))??'absent';}
}
