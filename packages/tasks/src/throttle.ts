import {ApiError} from '../../contracts/src/index.ts';
export class AuthenticationThrottle{
  buckets=new Map<string,{start:number;count:number}>();
  enter(address:string){const now=Date.now();for(const [key,bucket]of this.buckets)if(now-bucket.start>=60000)this.buckets.delete(key);if(this.buckets.size>=1000&&!this.buckets.has(address))throw new ApiError('RATE_LIMITED','Authentication request capacity is exhausted');const bucket=this.buckets.get(address)??{start:now,count:0};this.buckets.set(address,bucket);if(++bucket.count>2000)throw new ApiError('RATE_LIMITED','Authentication request rate is exceeded');}
}
