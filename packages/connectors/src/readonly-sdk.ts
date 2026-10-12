import {ApiError,MAX_SOURCE_BYTES,requireCondition,sha256} from '../../contracts/src/index.ts';

export interface RawReturn {path:string;bytes:Buffer;sha256:string;mediaType:string;etag:string|null;sourceType?:string}
export interface SourceOptions {authorization?:()=>string|Promise<string>;timeoutMs?:number;absenceTtlMs?:number}
export interface Incremental<T> {items:T[];cursor:Record<string,string>;evidence:RawReturn[]}

// Transport errors never interpolate a URL, authorization value or source body.
export class HttpSource {
  #origin:URL;#options:SourceOptions;#absent=new Map<string,number>();
  constructor(origin:string,options:SourceOptions={}) {
    let url:URL;try{url=new URL(origin);}catch{throw new ApiError('INVALID_PAYLOAD','Use a valid runtime HTTP origin');}
    requireCondition(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password,'INVALID_PAYLOAD','Use a runtime HTTP origin without embedded credentials');
    this.#origin=url;this.#options=options;
  }
  path(reference:string,relativeTo?:string):string {
    const base=relativeTo?new URL(relativeTo,this.#origin):this.#origin,url=new URL(reference,base);
    requireCondition(url.origin===this.#origin.origin&&!url.username&&!url.password,'INVALID_PAYLOAD','Source links must remain on the configured origin');
    return url.pathname+url.search;
  }
  async read(path:string,options:{method?:'GET'|'POST'|'PROPFIND';json?:unknown;headers?:Record<string,string>}={}):Promise<RawReturn> {
    const target=this.path(path),authorization=await this.#options.authorization?.();
    const key=sha256(JSON.stringify([authorization??'',target,options.method??'GET',options.json??null]));
    if((this.#absent.get(key)??0)>Date.now())throw new ApiError('SOURCE_ABSENT','Source object is absent');
    try {
      const response=await fetch(new URL(target,this.#origin),{method:options.method??'GET',redirect:'manual',signal:AbortSignal.timeout(this.#options.timeoutMs??5000),
        headers:{...options.headers,...(authorization?{authorization}:{}),...(options.json===undefined?{}:{'content-type':'application/json'})},
        ...(options.json===undefined?{}:{body:JSON.stringify(options.json)})});
      if(response.status===404){this.#absent.set(key,Date.now()+(this.#options.absenceTtlMs??1000));throw new ApiError('SOURCE_ABSENT','Source object is absent');}
      if(response.status===401)throw new ApiError('SOURCE_LOGIN_EXPIRED','Source login has expired');
      if(response.status===403)throw new ApiError('SOURCE_FORBIDDEN','Source object is not available to this identity');
      if(!response.ok)throw new ApiError('SOURCE_UNREACHABLE','Source did not return a readable response');
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of response.body??[]){size+=chunk.length;requireCondition(size<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Source return exceeds the byte limit');chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks);return {path:target,bytes,sha256:sha256(bytes),mediaType:response.headers.get('content-type')??'application/octet-stream',etag:response.headers.get('etag')};
    }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('SOURCE_UNREACHABLE','Source cannot be reached');}
  }
  async json(path:string,options:{method?:'GET'|'POST';json?:unknown}={}):Promise<{result:any;evidence:RawReturn}> {
    const evidence=await this.read(path,options);
    try{return {result:JSON.parse(evidence.bytes.toString('utf8')),evidence};}catch{throw new ApiError('SOURCE_UNREACHABLE','Source returned invalid JSON');}
  }
}
