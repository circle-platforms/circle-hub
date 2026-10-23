// Transport failures may be retried; explicit refusals require a deployment-declared safe predicate.
import { canonicalBytes, canonicalize, sha256Hex } from '../records/api.ts';
import { at, bind, type ExecutorDefinition } from './definition.ts';
import { HttpReplyError, InvocationDefinitionError, RpcReplyError, ResponseStorageError, ToolReplyError } from './transport.ts';
export function canRetryRead(error:unknown,d:ExecutorDefinition,context:Readonly<Record<string,unknown>>):boolean {
  if(error instanceof InvocationDefinitionError || error instanceof ResponseStorageError || error instanceof RpcReplyError)return false;
  if(error instanceof HttpReplyError)return error.status>=500 || error.status===408 || error.status===409 || error.status===423 || error.status===429;
  if(!(error instanceof ToolReplyError))return true;
  try {
    return d.read_retry_when.length>0 && d.read_retry_when.every(c=>{
      const actual=at(error.value,c.pointer);if(actual===undefined)return false;
      if(Object.hasOwn(c,'equals'))return canonicalize(actual)===canonicalize(bind(c.equals,context));
      if(c.at_least!==undefined) {const expected=bind(c.at_least,context);return typeof actual==='number' && typeof expected==='number' && actual>=expected;}
      return sha256Hex(canonicalBytes(actual))===bind(c.sha256,context);
    });
  }catch{return false;}
}
