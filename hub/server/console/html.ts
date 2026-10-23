// Server-rendered HTML for the read-only console: a tagged template that escapes every interpolated value, a fixed
// stylesheet allowed by its hash in a strict Content-Security-Policy, and no script at all. Dynamic values only ever go into
// element text or double-quoted attributes; links are built from fixed paths and encoded query parameters.
import { createHash } from 'node:crypto';

/** Markup that is already safe: produced by `html` or a constant of this module. */
export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

function render(value: unknown): string {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/** Escapes every interpolation that is not already Html; arrays are joined. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/** A path of this console with encoded query parameters (undefined and empty values are left out). */
export function href(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  const text = query.toString();
  return text.length === 0 ? path : `${path}?${text}`;
}

export function link(path: string, text: unknown, params: Record<string, string | number | null | undefined> = {}): Html {
  return html`<a href="${href(path, params)}">${text}</a>`;
}

export function table(headers: readonly string[], rows: readonly unknown[][], empty = '没有记录'): Html {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<table><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map(
    (row) => html`<tr>${row.map((cell) => html`<td>${cell}</td>`)}</tr>`,
  )}</tbody></table>`;
}

export function definitions(pairs: readonly (readonly [string, unknown])[]): Html {
  return html`<dl>${pairs.map(([term, value]) => html`<dt>${term}</dt><dd>${value}</dd>`)}</dl>`;
}

export function section(title: string, body: unknown): Html {
  return html`<section><h2>${title}</h2>${body}</section>`;
}

/** Monospace text, for digests, references and JSON. */
export function code(value: unknown): Html {
  return html`<code>${value}</code>`;
}

export function pre(value: unknown): Html {
  return html`<pre>${value}</pre>`;
}

const CSS = `body{font-family:-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;margin:0;color:#1d1d1f;background:#fafafa}
header{display:flex;gap:1.2em;align-items:center;padding:.6em 1.2em;background:#20232a;color:#fff;flex-wrap:wrap}
header a{color:#cfe3ff;text-decoration:none}header .who{margin-left:auto}header form{margin:0}
main{padding:1em 1.4em;max-width:110em}h1{font-size:1.4em}h2{font-size:1.15em;margin-top:1.6em}
table{border-collapse:collapse;margin:.4em 0;font-size:.92em}th,td{border:1px solid #d0d0d5;padding:.25em .5em;vertical-align:top;text-align:left}
th{background:#eef0f4}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:.88em;word-break:break-all}
pre{white-space:pre-wrap;background:#f0f0f3;padding:.6em;max-height:40em;overflow:auto}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2em 1em}dt{font-weight:600}dd{margin:0}
.empty{color:#666}.error{color:#a1001b}.notice{background:#fff6d6;padding:.5em}
.claim{border-left:3px solid #8aa0c8;padding-left:.6em;margin:.4em 0}
form.filters input{margin-right:.6em}
.t-pass{color:#1a6b2f}.t-failure{color:#a1001b}.t-judgment{color:#24508f}.t-incomplete{color:#6b5300}
.t-unknown{color:#7a3fb0;font-weight:600}
.unverified{background:#fff6d6}details summary{cursor:pointer}`;

const CSS_HASH = createHash('sha256').update(CSS, 'utf8').digest('base64');

/** No script, no external asset, no framing; only the stylesheet below by its hash, and forms to this console. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${CSS_HASH}'`,
  "img-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export interface PageChrome {
  title: string;
  /** Signed-in user: name and role label; null on the login page. */
  user: { name: string; role: string; admin: boolean } | null;
  /** CSRF token of the session for the logout form. */
  csrf: string | null;
}

export function page(chrome: PageChrome, body: unknown): Html {
  const nav = chrome.user === null
    ? html``
    : html`<nav>${link('/console/runs', '运行')} ${link('/console/results', '结果')} ${link('/console/knowledge', '知识')} ${link('/console/packs', '任务包')} ${chrome.user.admin ? link('/console/admin', '管理') : ''}</nav>
<span class="who">${chrome.user.name}（${chrome.user.role}）</span>
<form method="post" action="/console/logout"><input type="hidden" name="csrf" value="${chrome.csrf ?? ''}"><button type="submit">退出</button></form>`;
  return html`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${chrome.title} · circle-hub</title><style>${new Html(CSS)}</style></head>
<body><header><strong>circle-hub</strong>${nav}</header><main><h1>${chrome.title}</h1>${body}</main></body></html>`;
}
