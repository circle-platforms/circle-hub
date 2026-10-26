// html@1: HTML read with parse5 (scripts are never run). Ordered text blocks (CSS block boxes, with <br> as a line
// break), links with their href exactly as written (quoted or not, never resolved), and formatting wrappers around
// text (font, b, em, ...) kept as flags with their attributes. Selectors: `b/<k>` block k, `b/<a>-<b>` blocks a to b
// (a < b, joined with LF) and `a/<k>` link k, all 0-based.
import { isUtf8 } from 'node:buffer';
import { defaultTreeAdapter, parse as parseHtml, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type TreeAdapter } from 'parse5';
import {
  ParseEncodingError,
  ParseError,
  ParseLimitError,
  ParseSyntaxError,
  QUOTATION_UNITS,
  attributesError,
  checkSize,
  depthError,
  effectiveLimits,
  mediaTypeCharset,
  nodesError,
  type ByteRange,
  type Fragment,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from './format.ts';
import { trySelectorSegments } from './selectors.ts';
import { bomCharset, decodeEncoding, legacyCharset, decodeSingleByte, decodeUtf8, isUtf8Label, isWindows1252Label, removeNul, type ByteOffsets } from './text-decoding.ts';

const KEY = 'html@1';
// Nodes count elements, text nodes and template contents.
const LIMITS: Readonly<ParseLimits> = { maxBytes: 16 * 1024 * 1024, maxDepth: 256, maxNodes: 2_000_000, maxAttributes: 512 };
const INDEX = /^(?:0|[1-9][0-9]{0,8})$/;
// Tree operations (child lists scanned or shifted) allowed per node of the node limit; parse5 can be driven into
// quadratic moves by misnested markup, so the total is bounded.
const WORK_PER_NODE = 64;
// Wrapper entries the model may list over all runs, per node of the node limit.
const WRAPPERS_PER_NODE = 4;

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'html', 'legend',
  'li', 'listing', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'plaintext', 'pre', 'search', 'section', 'select',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'xmp',
]);
const WRAPPERS = new Set([
  'abbr', 'b', 'big', 'blink', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'nobr', 'q', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'tt', 'u', 'var',
]);
const PRESERVE = new Set(['pre', 'listing', 'plaintext', 'xmp']);
const SKIP = new Set(['script', 'style', 'template', 'textarea', 'iframe', 'noembed', 'noframes', 'object', 'embed']);
// Elements whose content the tokenizer reads as raw text in HTML (not foreign) content.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

export type HtmlWrapper = { tag: string; attributes: { [name: string]: string } };
export type HtmlRun = { text: string; wrappers: HtmlWrapper[]; link: number | null };
export type HtmlBlock = {
  /** Nearest enclosing block element (an anonymous block takes its parent's tag). */
  tag: string;
  text: string;
  /** Distinct wrapper tags around any text of the block, outermost first. */
  flags: string[];
  runs: HtmlRun[];
  links: number[];
  range: ByteRange | null;
};
export type HtmlLink = { href: string | null; text: string; block: number | null; wrappers: HtmlWrapper[]; range: ByteRange | null };
export type HtmlModel = { charset: string; title: string | null; blocks: HtmlBlock[]; links: HtmlLink[] };

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

function isHtmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * parse5 compares each new attribute with all earlier ones of the same tag, so one tag with very many attributes costs
 * quadratic time. This linear scan counts attributes per tag first. It only ever over-counts relative to the HTML
 * tokenizer: raw-text elements are skipped only when no context can make parse5 ignore their start tag (foreign
 * content, frameset, and select, where style, xmp, iframe, noembed, noframes, title and plaintext are ignored and their
 * content is read as markup); comments end at their first '>'.
 */
function checkAttributeCounts(html: string, max: number, offsets: ByteOffsets | null): void {
  const skipRawText = !/<(?:svg|math|frameset|select)[\s/>]/i.test(html);
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;
    let j = lt + 1;
    const c = html.charCodeAt(j);
    if (c === 0x21 || c === 0x3f) {
      const end = html.indexOf('>', j);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = c === 0x2f;
    if (closing) j++;
    if (!isAsciiAlpha(html.charCodeAt(j))) {
      i = lt + 1;
      continue;
    }
    const nameStart = j;
    while (j < n) {
      const d = html.charCodeAt(j);
      if (isHtmlSpace(d) || d === 0x2f || d === 0x3e) break;
      j++;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    let count = 0;
    while (j < n) {
      const d = html.charCodeAt(j);
      if (d === 0x3e) {
        j++;
        break;
      }
      if (isHtmlSpace(d) || d === 0x2f) {
        j++;
        continue;
      }
      if (++count > max) throw attributesError(KEY, max, offsets ? offsets.at(lt) : null);
      j++;
      while (j < n) {
        const e = html.charCodeAt(j);
        if (isHtmlSpace(e) || e === 0x2f || e === 0x3e || e === 0x3d) break;
        j++;
      }
      while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
      if (html.charCodeAt(j) !== 0x3d) continue;
      j++;
      while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
      const q = html.charCodeAt(j);
      if (q === 0x22 || q === 0x27) {
        const end = html.indexOf(q === 0x22 ? '"' : "'", j + 1);
        j = end < 0 ? n : end + 1;
      } else {
        while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 0x3e) j++;
      }
    }
    i = j;
    if (!closing && skipRawText && RAW_TEXT.has(name)) {
      if (name === 'plaintext') return;
      const end = new RegExp(`</${name}`, 'ig');
      end.lastIndex = j;
      const found = end.exec(html);
      i = found ? found.index : n;
    }
  }
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(1024, bytes.byteLength)).toString('latin1');
  const match = /<meta\b[^>]*?\bcharset[ \t\n\f\r]*=[ \t\n\f\r]*["']?[ \t\n\f\r]*([A-Za-z0-9._:-]+)/i.exec(head);
  return match ? match[1].toLowerCase() : null;
}

function decode(bytes: Uint8Array, mediaType: string | undefined): { text: string; charset: string; offsets: ByteOffsets | null } {
  const marker = bomCharset(bytes);
  if (marker) return decodeEncoding(KEY, bytes, marker);
  const parameter = mediaTypeCharset(mediaType);
  let label = parameter ?? metaCharset(bytes) ?? (isUtf8(bytes) ? 'utf-8' : 'windows-1252');
  if (parameter === null && label.startsWith('utf-16')) label = 'utf-8';
  if (isUtf8Label(label)) {
    const decoded = decodeUtf8(KEY, bytes);
    return { text: decoded.text, charset: 'utf-8', offsets: decoded.offsets };
  }
  if (isWindows1252Label(label)) {
    const decoded = decodeSingleByte(KEY, bytes, 'windows-1252');
    return { text: decoded.text, charset: 'windows-1252', offsets: decoded.offsets };
  }
  const legacy = legacyCharset(label);
  if (legacy) return decodeEncoding(KEY, bytes, legacy);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new ParseEncodingError(KEY, parameter === null ? 'HTML <meta> 声明了不支持的字符编码' : 'HTML 媒体类型 charset 声明了不支持的字符编码', null, label);
  }
  // Other legacy encodings decode, but without byte ranges.
  return { text: decoder.decode(bytes), charset: decoder.encoding, offsets: null };
}

/** The decoded text of HTML bytes, by the same charset rules as html@1 (the whole-file text of an HTML source). */
export function decodeHtmlText(bytes: Uint8Array, mediaType: string | undefined): string {
  return decode(bytes, mediaType).text;
}

/**
 * The default tree adapter with every mutation guarded: depth and node limits for elements, text nodes and template
 * contents; child lists searched from the end (foster parenting inserts before the table, the last child) with the
 * scanned and shifted entries charged to a work budget; attribute merging of repeated <html> and <body> tags capped.
 */
function guardedAdapter(limits: Required<ParseLimits>, stats: { nodes: number; depth: number; work: number }): TreeAdapter<DefaultTreeAdapterMap> {
  const depths = new WeakMap<object, number>();
  // Template contents and their templates: parse5 sets a content before it attaches the template.
  const templates = new WeakMap<object, object>();
  const depthOf = (node: object): number => {
    const known = depths.get(node);
    if (known !== undefined) return known;
    const template = templates.get(node);
    return template === undefined ? 0 : (depths.get(template) ?? 0);
  };
  const budget = WORK_PER_NODE * limits.maxNodes;
  const charge = (steps: number): void => {
    stats.work += steps;
    if (stats.work > budget) {
      throw new ParseLimitError(KEY, 'maxNodes', limits.maxNodes, `HTML 结构过于混乱：重排节点的工作量超过节点数上限 ${limits.maxNodes} 的 ${WORK_PER_NODE} 倍`, null, '减少错位嵌套或表格外移的内容，或拆分 HTML 文件后重新上传');
    }
  };
  const count = (): void => {
    if (++stats.nodes > limits.maxNodes) throw nodesError(KEY, limits.maxNodes);
  };
  const admit = (parent: object, child: object): void => {
    const depth = depthOf(parent) + 1;
    if (depth > limits.maxDepth) throw depthError(KEY, limits.maxDepth);
    count();
    if (depth > stats.depth) stats.depth = depth;
    depths.set(child, depth);
  };
  // Index of `node` in `list`, searched from both ends; the steps are charged.
  const indexOf = (list: readonly ChildNode[], node: ChildNode): number => {
    for (let low = 0, high = list.length - 1; low <= high; low++, high--) {
      if (list[high] === node) {
        charge(list.length - high);
        return high;
      }
      if (list[low] === node) {
        charge(low + 1);
        return low;
      }
    }
    charge(list.length);
    return -1;
  };
  const insertAt = (parent: ParentNode, child: ChildNode, reference: ChildNode): void => {
    const list = parent.childNodes;
    const at = indexOf(list, reference);
    if (at < 0) list.push(child);
    else {
      charge(list.length - at);
      list.splice(at, 0, child);
    }
    child.parentNode = parent;
  };
  return {
    ...defaultTreeAdapter,
    appendChild(parent, child) {
      admit(parent, child);
      parent.childNodes.push(child);
      child.parentNode = parent;
    },
    insertBefore(parent, child, reference) {
      admit(parent, child);
      insertAt(parent, child, reference);
    },
    insertText(parent, text) {
      const last = parent.childNodes[parent.childNodes.length - 1];
      if (last !== undefined && defaultTreeAdapter.isTextNode(last)) {
        last.value += text;
        return;
      }
      count();
      const node = defaultTreeAdapter.createTextNode(text);
      parent.childNodes.push(node);
      node.parentNode = parent;
    },
    insertTextBefore(parent, text, reference) {
      const list = parent.childNodes;
      const at = indexOf(list, reference);
      const previous = at > 0 ? list[at - 1] : undefined;
      if (previous !== undefined && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      count();
      insertAt(parent, defaultTreeAdapter.createTextNode(text), reference);
    },
    detachNode(node) {
      const parent = node.parentNode;
      if (!parent) return;
      const list = parent.childNodes;
      const at = indexOf(list, node);
      if (at >= 0) {
        charge(list.length - at);
        list.splice(at, 1);
      }
      node.parentNode = null;
    },
    setTemplateContent(template, content) {
      // The content's children sit one level below the template, so depth keeps counting through nested templates.
      count();
      templates.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
    adoptAttributes(recipient, attrs) {
      // Repeated <html> and <body> tags add their attributes to the first one; the element stays within maxAttributes.
      charge(recipient.attrs.length + attrs.length);
      const present = new Set(recipient.attrs.map((attribute) => attribute.name));
      for (const attribute of attrs) {
        if (present.has(attribute.name)) continue;
        if (recipient.attrs.length + 1 > limits.maxAttributes) throw new ParseLimitError(KEY, 'maxAttributes', limits.maxAttributes, `重复 html/body 标签合并后的累计属性数超过上限 ${limits.maxAttributes}`, null, `合并重复 html/body 标签，使累计属性数不超过 ${limits.maxAttributes} 后重新上传`);
        present.add(attribute.name);
        recipient.attrs.push(attribute);
      }
    },
  };
}

function attributesOf(element: Element): { [name: string]: string } {
  const out: { [name: string]: string } = {};
  for (const attribute of element.attrs) {
    if (!Object.hasOwn(out, attribute.name)) Object.defineProperty(out, attribute.name, { value: attribute.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function squeeze(text: string): string {
  return text.replace(/[\t\n\f\r ]+/g, ' ');
}

/** The wrappers around a run, as a chain from the innermost; each chain lists itself as an array once, when first asked. */
type WrapperChain = { wrapper: HtmlWrapper; parent: WrapperChain | null; depth: number; list: HtmlWrapper[] | null };

function parse(bytes: Uint8Array, options: ParseOptions = {}): ParsedDocument<HtmlModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const { text: source, charset, offsets } = decode(bytes, options.mediaType);
  checkAttributeCounts(source, limits.maxAttributes, offsets);
  const stats = { nodes: 0, depth: 0, work: 0 };
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parseHtml(source, { sourceCodeLocationInfo: true, scriptingEnabled: false, treeAdapter: guardedAdapter(limits, stats) });
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseSyntaxError(KEY, 'HTML 解析失败', null, String(error));
  }

  const byteRange = (start: number, end: number): ByteRange | null => (offsets ? [offsets.at(start), offsets.at(end)] : null);
  const blocks: HtmlBlock[] = [];
  const links: HtmlLink[] = [];
  const linkParts: string[][] = [];
  // Links whose text runs fall into more than one block: their text is not inside any single block.
  const spread: boolean[] = [];
  let title: string | null = null;
  let listed = 0;
  const wrapperBudget = WRAPPERS_PER_NODE * limits.maxNodes;
  // One empty list per document, shared by its runs outside any wrapper (models of two documents share nothing).
  const noWrappers: HtmlWrapper[] = [];
  const listOf = (chain: WrapperChain | null): HtmlWrapper[] => {
    if (chain === null) return noWrappers;
    if (chain.list === null) {
      listed += chain.depth;
      if (listed > wrapperBudget) {
        throw new ParseLimitError(KEY, 'maxNodes', limits.maxNodes, `HTML 的格式标签嵌套过深且文字过多：各段文字列出的格式标签总数超过节点数上限 ${limits.maxNodes} 的 ${WRAPPERS_PER_NODE} 倍`, null, '减少格式标签的嵌套，或拆分 HTML 文件后重新上传');
      }
      const list = new Array<HtmlWrapper>(chain.depth);
      for (let at: WrapperChain | null = chain, k = chain.depth - 1; at !== null; at = at.parent, k--) list[k] = at.wrapper;
      chain.list = list;
    }
    return chain.list;
  };
  type Run = { text: string; chain: WrapperChain | null; link: number | null; pre: boolean; br: boolean };
  let runs: Run[] = [];
  let start = -1;
  let end = -1;
  // Reassigned in the exit closures below, so declared without narrowing to the initial null.
  let wrappers = null as WrapperChain | null;
  const linkStack: number[] = [];
  const blockTags: string[] = [];
  let preserve = 0;

  const flush = (): void => {
    if (runs.length === 0) return;
    const pending = runs;
    const span = start >= 0 ? byteRange(start, end) : null;
    runs = [];
    start = -1;
    end = -1;
    let text: string;
    if (pending.every((run) => run.pre)) text = pending.map((run) => run.text).join('');
    else {
      const lines = pending
        .map((run) => run.text)
        .join('')
        .split('\n')
        .map((line) => line.replace(/ {2,}/g, ' ').replace(/^ +| +$/g, ''));
      while (lines.length > 0 && lines[0] === '') lines.shift();
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      text = lines.join('\n');
    }
    if (text.trim() === '') return;
    const index = blocks.length;
    const merged: HtmlRun[] = [];
    const flags: string[] = [];
    const flagged = new Set<WrapperChain>();
    const blockLinks: number[] = [];
    const linked = new Set<number>();
    let previous: Run | null = null;
    for (const run of pending) {
      if (run.chain !== null && !flagged.has(run.chain)) {
        flagged.add(run.chain);
        for (const wrapper of listOf(run.chain)) if (!flags.includes(wrapper.tag)) flags.push(wrapper.tag);
      }
      if (run.link !== null) {
        if (!linked.has(run.link)) {
          linked.add(run.link);
          blockLinks.push(run.link);
        }
        const link = links[run.link];
        if (link.block === null) link.block = index;
        else if (link.block !== index) spread[run.link] = true;
      }
      if (previous !== null && !previous.br && !run.br && previous.chain === run.chain && previous.link === run.link) {
        merged[merged.length - 1].text += run.text;
      } else merged.push({ text: run.text, wrappers: listOf(run.chain), link: run.link });
      previous = run;
    }
    blocks.push({ tag: blockTags[blockTags.length - 1] ?? 'body', text, flags, runs: merged, links: blockLinks, range: span });
  };
  const addRun = (value: string, node: Node | null, br: boolean): void => {
    const link = linkStack.length > 0 ? linkStack[linkStack.length - 1] : null;
    runs.push({ text: value, chain: wrappers, link, pre: preserve > 0, br });
    if (link !== null) linkParts[link].push(br ? ' ' : value);
    const location = node && 'sourceCodeLocation' in node ? node.sourceCodeLocation : null;
    if (location) {
      if (start < 0 || location.startOffset < start) start = location.startOffset;
      if (location.endOffset > end) end = location.endOffset;
    }
  };
  const textOf = (node: Node): string => {
    const parts: string[] = [];
    const stack: Node[] = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.nodeName === '#text') parts.push((current as DefaultTreeAdapterTypes.TextNode).value);
      else if ('childNodes' in current) for (let k = current.childNodes.length - 1; k >= 0; k--) stack.push(current.childNodes[k]);
    }
    return parts.join('');
  };

  type Frame = { node: Node; next: number; exit: (() => void) | null };
  const frames: Frame[] = [{ node: document, next: 0, exit: null }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const children = 'childNodes' in frame.node ? frame.node.childNodes : [];
    if (frame.next >= children.length) {
      frames.pop();
      frame.exit?.();
      continue;
    }
    const node = children[frame.next++];
    if (node.nodeName === '#text') {
      const raw = removeNul((node as DefaultTreeAdapterTypes.TextNode).value);
      const value = preserve > 0 ? raw : squeeze(raw);
      if (value !== '') addRun(value, node, false);
      continue;
    }
    if (!('tagName' in node)) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    if (tag === 'title') {
      if (title === null) title = squeeze(removeNul(textOf(element))).trim();
      continue;
    }
    if (tag === 'br') {
      addRun('\n', element, true);
      continue;
    }
    if (tag === 'hr') {
      flush();
      continue;
    }
    const isBlock = BLOCK.has(tag);
    const isWrapper = WRAPPERS.has(tag);
    const isLink = tag === 'a';
    const isPre = PRESERVE.has(tag);
    const savedWrappers = wrappers;
    if (isBlock) {
      flush();
      blockTags.push(tag);
    }
    if (isPre) preserve++;
    if (isWrapper) wrappers = { wrapper: { tag, attributes: attributesOf(element) }, parent: wrappers, depth: (wrappers?.depth ?? 0) + 1, list: null };
    if (isLink) {
      const location = element.sourceCodeLocation;
      const href = element.attrs.find((attribute) => attribute.name === 'href');
      links.push({
        href: href ? href.value : null,
        text: '',
        block: null,
        wrappers: listOf(wrappers),
        range: location ? byteRange(location.startOffset, location.endOffset) : null,
      });
      linkParts.push([]);
      spread.push(false);
      linkStack.push(links.length - 1);
    }
    frames.push({
      node: element,
      next: 0,
      exit: () => {
        if (isLink) linkStack.pop();
        if (isWrapper) wrappers = savedWrappers;
        if (isPre) preserve--;
        if (isBlock) {
          flush();
          blockTags.pop();
        }
      },
    });
  }
  flush();
  links.forEach((link, index) => {
    link.text = squeeze(linkParts[index].join('')).replace(/^ +| +$/g, '');
  });
  const model: HtmlModel = { charset, title, blocks, links };

  // The block texts joined with LF: the text of `b/<a>-<b>`, and every block is a slice of it.
  let joined: { text: string; at: Int32Array } | null = null;
  const stream = (): { text: string; at: Int32Array } => {
    if (joined) return joined;
    const at = new Int32Array(blocks.length + 1);
    for (let k = 0; k < blocks.length; k++) at[k + 1] = at[k] + blocks[k].text.length + 1;
    return (joined = { text: blocks.map((block) => block.text).join('\n'), at });
  };
  const rangeOf = (first: number, last: number): ByteRange | null => {
    const from = blocks[first].range;
    const to = blocks[last].range;
    return from && to ? [from[0], to[1]] : null;
  };

  const blockFragment = (index: number): Fragment => {
    const block = blocks[index];
    return {
      selector: `b/${index}`,
      text: block.text,
      byteRange: block.range,
      data: {
        tag: block.tag,
        flags: block.flags,
        links: block.links.map((link) => `a/${link}`),
        runs: block.runs.map((run) => ({ text: run.text, flags: run.wrappers.map((w) => w.tag), wrappers: run.wrappers, link: run.link === null ? null : `a/${run.link}` })),
      },
    };
  };
  const blocksFragment = (first: number, last: number): Fragment => {
    const shared = stream();
    return {
      selector: `b/${first}-${last}`,
      text: shared.text.slice(shared.at[first], shared.at[last + 1] - 1),
      byteRange: rangeOf(first, last),
      data: { first: `b/${first}`, last: `b/${last}`, blocks: last - first + 1 },
    };
  };
  const linkFragment = (index: number): Fragment => {
    const link = links[index];
    return {
      selector: `a/${index}`,
      text: link.text,
      byteRange: link.range,
      data: { href: link.href, block: link.block === null ? null : `b/${link.block}`, flags: link.wrappers.map((w) => w.tag), wrappers: link.wrappers },
    };
  };

  const parsed: ParsedDocument<HtmlModel> & QuotationSource = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments.length !== 2) return null;
      const dash = segments[1].indexOf('-');
      if (segments[0] === 'b' && dash > 0) {
        const first = segments[1].slice(0, dash);
        const last = segments[1].slice(dash + 1);
        if (!INDEX.test(first) || !INDEX.test(last) || Number(first) >= Number(last) || Number(last) >= blocks.length) return null;
        return blocksFragment(Number(first), Number(last));
      }
      if (!INDEX.test(segments[1])) return null;
      const index = Number(segments[1]);
      if (segments[0] === 'b') return index < blocks.length ? blockFragment(index) : null;
      if (segments[0] === 'a') return index < links.length ? linkFragment(index) : null;
      return null;
    },
    listSelectors(prefix = '', options = {}) {
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      for (let index = 0; index < blocks.length && out.length < limit; index++) if (`b/${index}`.startsWith(prefix)) out.push(`b/${index}`);
      for (let index = 0; index < links.length && out.length < limit; index++) if (`a/${index}`.startsWith(prefix)) out.push(`a/${index}`);
      return out;
    },
    summary() {
      return { parser: KEY, charset, title: title !== null, blocks: blocks.length, links: links.length, nodes: stats.nodes, depth: stats.depth };
    },
    [QUOTATION_UNITS]() {
      // All blocks first, so that a quotation across blocks resolves to them; then each block; then the links, inside
      // the block that holds their whole text.
      const shared = stream();
      const units: QuotationUnit[] = [];
      const whole = blocks.length >= 2 ? 0 : -1;
      if (whole === 0) units.push({ selector: `b/0-${blocks.length - 1}`, text: shared.text, byteRange: rangeOf(0, blocks.length - 1), parent: -1, start: 0, end: shared.text.length });
      const first = units.length;
      blocks.forEach((block, index) => {
        units.push({ selector: `b/${index}`, text: block.text, byteRange: block.range, parent: whole, start: shared.at[index], end: shared.at[index + 1] - 1 });
      });
      links.forEach((link, index) => {
        const parent = link.block !== null && !spread[index] ? first + link.block : -1;
        units.push({ selector: `a/${index}`, text: link.text, byteRange: link.range, parent, start: -1, end: -1 });
      });
      return { stream: shared.text, units };
    },
  };
  return parsed;
}

export const htmlParser: Parser<HtmlModel> = { id: 'html', version: 1, mediaTypes: ['text/html', 'application/xhtml+xml'], limits: LIMITS, parse };
