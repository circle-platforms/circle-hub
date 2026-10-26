// Text views of stored bytes. PostgreSQL text rejects NUL, so text derived from bytes drops it; the object keeps the original bytes.

export function stripNul(text: string): string {
  return text.includes('\0') ? text.replaceAll('\0', '') : text;
}

export interface TextPreview {
  text: string;
  /** True when the bytes were longer than the preview. */
  truncated: boolean;
  /** Number of NUL characters removed. */
  nulStripped: number;
}

/**
 * Decodes up to `maxBytes` bytes as UTF-8 (invalid sequences become U+FFFD), never splitting a multi-byte character at the cut,
 * and strips NUL. The input bytes are not modified.
 */
export function textPreview(bytes: Uint8Array, maxBytes = 1024 * 1024): TextPreview {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative integer');
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  // Streaming decode holds back an incomplete trailing sequence instead of emitting U+FFFD for it.
  const decoded = new TextDecoder('utf-8').decode(slice, { stream: truncated });
  const text = stripNul(decoded);
  return { text, truncated, nulStripped: decoded.length - text.length };
}
