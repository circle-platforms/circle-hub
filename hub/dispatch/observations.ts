// Protocol decoding and audit hashes shared by the transport and offline conversion tooling.
import { canonicalBytes, sha256Hex, parseStrictJson } from '../records/api.ts';
import { at } from './definition.ts';
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function rpcResponse(text: string, id?: number): Record<string, unknown> {
  const candidates: unknown[] = [];
  try { candidates.push(parseStrictJson(text)); } catch {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { candidates.push(parseStrictJson(data)); } catch { /* Not a complete response frame. */ }
    }
  }
  const replies = candidates.filter(isObject).filter(v => v.jsonrpc === '2.0' && Object.hasOwn(v, 'id') && (id === undefined || v.id === id) && Object.hasOwn(v, 'result'));
  if (replies.length !== 1 || replies[0].error !== undefined || !isObject(replies[0].result)) throw new Error('目标 JSON-RPC 回答无效或不唯一；原文先保存');
  return replies[0].result;
}
export function toolContent(result: Record<string, unknown>, allowError = false): unknown {
  if (result.isError === true && !allowError) throw new Error('目标工具报告错误；回答已保存');
  if (Object.hasOwn(result, 'structuredContent')) {
    if (!isObject(result.structuredContent)) throw new Error('目标结构化回答不是对象；回答已保存');
    return result.structuredContent;
  }
  const text = Array.isArray(result.content) ? result.content.filter(isObject).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  try { return parseStrictJson(text); } catch { throw new Error('目标工具回答不是有效 JSON；回答已保存'); }
}
/** The pointer addresses the decoded tool value, never the transport's request id or envelope. */
export function observationHashes(bytes: Uint8Array, pointer: string, allowError = false): { pointer: string; original_sha256: string; canonical_content_sha256: string } {
  if (pointer !== '' && !/^\/(?:[^~]|~[01])*$/.test(pointer)) throw new Error('观察指针不是有效 JSON 指针');
  const value = at(toolContent(rpcResponse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),allowError), pointer);
  if (value === undefined) throw new Error('观察指针缺少事实，不能用 null 代替');
  return { pointer, original_sha256: sha256Hex(bytes), canonical_content_sha256: sha256Hex(canonicalBytes(value)) };
}

/** Framing only: identify a complete reply to this POST without interpreting its tool data. */
export function containsRpcReply(text: string, id: number): boolean {
  for (const frame of text.split(/\r?\n\r?\n/).slice(0, -1)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    try {
      const value = parseStrictJson(data);
      if (isObject(value) && value.jsonrpc === '2.0' && value.id === id && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))) return true;
    } catch { /* Incomplete or unrelated frame; retain bytes and wait within the bound. */ }
  }
  return false;
}
