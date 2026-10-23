// upload_file helpers: strict base64 decoding, the media type (given, from the file name, or sniffed from the bytes) and the
// structure summary of the core parser that recognises the file. The bytes are stored by records (B02); nothing is executed.
import { mediaTypeEssence, parserKey, recognize, type ParseError, type ParserRegistry } from '../refs/api.ts';

/**
 * RFC 4648 base64 with padding and nothing else: the contracts schema already limits the alphabet and the length; this also
 * refuses non-canonical padding bits (two texts for the same bytes) by re-encoding. Null when the text is not canonical.
 */
export function decodeBase64Strict(text: string): Buffer | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** The decoded size of a padded base64 text, without decoding it. */
export function base64Size(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/** Same rule as records (objects.ts): type/subtype with optional parameters, at most 200 characters. */
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(\s*;\s*[A-Za-z0-9!#$&^_.+-]+=("[^"\\\r\n]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;

export function isMediaType(value: string): boolean {
  return value.length <= 200 && MEDIA_TYPE.test(value);
}

const BY_EXTENSION: Record<string, string> = {
  json: 'application/json',
  km: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function startsWithText(bytes: Uint8Array, prefix: RegExp): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').replace(/^﻿/, '').trimStart();
  return prefix.test(head);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // Text has no NUL and few other C0 controls (tab, line feed and carriage return are text); the first MiB decides.
  const head = text.length > 1 << 20 ? text.slice(0, 1 << 20) : text;
  let controls = 0;
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code === 0) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  return controls <= head.length / 100;
}

/** An actual declared type or a recognized filename extension is authoritative; byte sniffing is only a hint. */
export function mediaTypeIsAuthoritative(given: string | undefined, name: string | undefined): boolean {
  if (given !== undefined) return true;
  const extension = name === undefined ? undefined : /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase();
  return extension !== undefined && Object.hasOwn(BY_EXTENSION, extension);
}

/** The media type of an upload: the caller's, else by the name's extension, else sniffed; application/octet-stream when unknown. */
export function mediaTypeFor(bytes: Uint8Array, given: string | undefined, name: string | undefined): string {
  if (given !== undefined) return given;
  const extension = name === undefined ? undefined : /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase();
  if (extension !== undefined && Object.hasOwn(BY_EXTENSION, extension)) return BY_EXTENSION[extension];
  if (!isUtf8Text(bytes)) return 'application/octet-stream';
  if (startsWithText(bytes, /^[{[]/)) {
    try {
      JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^﻿/, ''));
      return 'application/json';
    } catch {
      return 'text/plain';
    }
  }
  if (startsWithText(bytes, /^<!doctype html|^<html[\s>]/i)) return 'text/html';
  if (startsWithText(bytes, /^<\?xml[\s?]|^<[A-Za-z_][\w.:-]*[\s>/]/)) return 'application/xml';
  return 'text/plain';
}

/** What the recognising parser says about the file's structure (counts and shape, never text), or null when none does. */
export function structureOf(parsers: ParserRegistry, bytes: Uint8Array, mediaType: string, onRejected?: (error: ParseError) => void): Record<string, unknown> | null {
  if (mediaTypeEssence(mediaType) === 'application/octet-stream') return null;
  const found = recognize(parsers, bytes, mediaType, {}, onRejected);
  if (found === null) return null;
  return { parser: parserKey(found.parser), summary: found.document.summary() };
}
