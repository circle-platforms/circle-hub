import type {ConnectorError} from './errors.ts';
export interface ReadRetry {at:string;attempts:number;code:ConnectorError['code']}
export const READ_TRANSPORT_RETRIES=2;
export const READ_RETRY_WAIT_MS=30_000;
/** NaN stays private to the transport and flags an invalid hint; valid values are never shortened. */
export function retryAfterMs(value:string|null,now:number):number|undefined {
  if(value===null)return undefined;if(value.length>128)return Number.NaN;
  const text=value.trim();const delay=/^\d+$/.test(text)?Number(text)*1000:Date.parse(text)-now;
  const target=new Date(now+Math.max(0,delay));
  return text!=='' && Number.isSafeInteger(delay) && Number.isFinite(target.getTime()) && target.toISOString().length===24?Math.max(0,delay):Number.NaN;
}
export function readRetryDelay(error:ConnectorError,retries:number):number|null {
  const status=error.detail.status;
  if(error.code!=='SOURCE_TIMEOUT' && error.code!=='SOURCE_UNREACHABLE' && !(error.code==='SOURCE_HTTP_STATUS' && typeof status==='number' && (status===429 || status>=500 && status<=599)))return null;
  const declared=error.detail.retry_after_ms;
  return Math.max(Math.min(100*2**retries,2000),typeof declared==='number' && Number.isFinite(declared)?declared:0);
}
