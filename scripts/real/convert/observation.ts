// Offline decoding uses exactly the dispatcher protocol decoder, JSON pointer and RFC 8785 hash.
import { ExecutorDefinition, at, observationHashes, rpcResponse, toolContent } from '../../../hub/dispatch/api.ts';
import { requireFact } from './io.ts';
export function observation(bytes: Uint8Array, definition: unknown, readIndex = '0', captureIndex = '0') {
  requireFact(/^(?:0|[1-9][0-9]*)$/.test(readIndex) && /^(?:0|[1-9][0-9]*)$/.test(captureIndex), '观察索引必须是非负整数；按管理员定义里的顺序指定');
  const parsed = ExecutorDefinition.safeParse(definition); requireFact(parsed.success, '执行器定义不合式；请管理员提供当前登记形状');
  const read = Number(readIndex) === 0 ? parsed.data : parsed.data.precheck_reads[Number(readIndex) - 1];
  requireFact(read, '缺少所选 precheck_reads 条目；请管理员核对定义中的只读核对顺序');
  const pointer = read.capture_pointers[Number(captureIndex)];
  requireFact(pointer !== undefined, '缺少所选只读核对的 capture_pointers 指针；请管理员在执行器定义声明覆盖拓扑、服务与观察的指针，再重跑');
  let decoded: unknown;
  try { decoded = toolContent(rpcResponse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { requireFact(false, '原始回答不是唯一完整的成功只读工具回答；请管理员重跑 job precheck 并保存完整原件'); }
  const value = at(decoded, pointer);
  requireFact(value !== undefined, `观察缺少已声明指针 ${pointer} 的事实；请管理员核对只读回答与 capture_pointers，重新 precheck 后再转换`);
  const hashes = observationHashes(bytes, pointer);
  for (const condition of read.conditions) if (condition.pointer === pointer && typeof condition.sha256 === 'string') requireFact(condition.sha256 === hashes.canonical_content_sha256, '观察内容与执行器声明摘要不符；请管理员重新只读预检、转换并更新定义，不绕过漂移');
  return { value, hashes };
}
