// Server-rendered HTML for the console: a tagged template that escapes every interpolated value, a fixed
// stylesheet (style.ts) and one fixed module script (script.ts, the live updates) allowed by their hashes in a strict
// Content-Security-Policy. Dynamic values only ever go into element text or double-quoted attributes; links are built
// from fixed paths and encoded query parameters. Every page of a signed-in account has the side navigation of the design
// canvas, and the script when the page has a live module; the login and setup pages are a card without it.
import { createHash } from 'node:crypto';
import type { LiveEventName } from './live.ts';
import { LIVE_SCRIPT } from './script.ts';
import { CSS } from './style.ts';

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

export function table(headers: readonly string[], rows: readonly unknown[][], empty = '没有记录', cls?: string): Html {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<div class="tablewrap"><table${cls === undefined ? '' : html` class="${cls}"`}><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map(
    (row) => html`<tr>${row.map((cell) => html`<td>${cell}</td>`)}</tr>`,
  )}</tbody></table></div>`;
}

export function definitions(pairs: readonly (readonly [string, unknown])[]): Html {
  return html`<dl>${pairs.map(([term, value]) => html`<dt>${term}</dt><dd>${value}</dd>`)}</dl>`;
}

export function section(title: string, body: unknown): Html {
  return html`<section><h2>${title}</h2>${body}</section>`;
}

/**
 * A module the live updates refresh (script.ts): a stable id, the events of console/live.ts that change it, and the run or
 * the job it shows when it shows one. It adds no box of its own.
 */
export function liveModule(id: string, events: readonly LiveEventName[], body: unknown, of: { run?: string; job?: string } = {}): Html {
  return html`<div class="live-module" id="live-${id}" data-live="${events.join(' ')}"${of.run === undefined ? '' : html` data-live-run="${of.run}"`}${of.job === undefined ? '' : html` data-live-job="${of.job}"`}>${body}</div>`;
}

/** Monospace text, for digests, references and JSON. */
export function code(value: unknown): Html {
  return html`<code>${value}</code>`;
}

export function pre(value: unknown): Html {
  return html`<pre>${value}</pre>`;
}

const CSS_HASH = createHash('sha256').update(CSS, 'utf8').digest('base64');
export const SCRIPT_HASH = createHash('sha256').update(LIVE_SCRIPT, 'utf8').digest('base64');

/**
 * No external asset and no framing; only the stylesheet of style.ts and the module of script.ts by their hashes, its event
 * stream and page fetches to this server, and forms to this console.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${CSS_HASH}'`,
  `script-src 'sha256-${SCRIPT_HASH}'`,
  "connect-src 'self'",
  "img-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/** The seven places of the console (proposal decision 3 of 2026-10-31): no sub-menus and no counters. */
export type NavKey = 'overview' | 'tasks' | 'knowledge' | 'packs' | 'connections' | 'records' | 'settings';

export interface PageChrome {
  title: string;
  /** Signed-in user: name and role label; null on the login page. */
  user: { name: string; role: string; admin: boolean } | null;
  /** CSRF token of the session for the logout form. */
  csrf: string | null;
  /** The place of the navigation this page belongs to; none on the neutral page, which never depends on the path. */
  active?: NavKey;
  /** One line under the title. */
  sub?: unknown;
  /** Buttons to the right of the title. */
  actions?: unknown;
  /** A page without an account shown as a wider card (the setup steps). */
  wide?: boolean;
}

/** Path data of the line icons (24 x 24, stroked), from the design canvas. */
export const ICONS = {
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  review: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  book: 'M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4zM5 16a4 4 0 0 1 4-4h10M9 8h6',
  pack: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9',
  sys: 'M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01',
  rec: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  warn: 'M12 3l9 16H3l9-16zM12 10v4M12 17h.01',
  terminal: 'M4 5h16v11H4zM8 20h8M7.5 9l2.5 2-2.5 2M12 13h4',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 15V4M7 9l5-5 5 5M5 20h14',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  key: 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 11h9M18 11v3M21 11v2',
  back: 'M15 18l-6-6 6-6',
  chat: 'M4 5h16v11H10l-5 4v-4H4z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2',
  flow: 'M3 6h5c5 0 5 12 10 12h3M3 18h5c2.5 0 3.5-3 4.5-6M15 6h6',
} as const;

export function icon(name: keyof typeof ICONS, cls = 'ico'): Html {
  return html`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"></path></svg>`;
}

const NAV: readonly (readonly [NavKey, string, string, keyof typeof ICONS])[] = [
  ['overview', '总览', '/console/overview', 'home'],
  ['tasks', '任务', '/console/runs', 'review'],
  ['knowledge', '知识库', '/console/knowledge', 'book'],
  ['packs', '任务包', '/console/packs', 'pack'],
  ['connections', '连接', '/console/connections', 'sys'],
  ['records', '记录', '/console/records', 'rec'],
  ['settings', '设置', '/console/settings', 'gear'],
];

function htmlDocument(title: string, body: Html, script = false): Html {
  return html`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · circle-hub</title><style>${new Html(CSS)}</style></head>
<body class="hub">${body}${script ? html`<script type="module">${new Html(LIVE_SCRIPT)}</script>` : ''}</body></html>`;
}

/** A page of the console: the side navigation and the signed-in account, then the title and the body. */
export function page(chrome: PageChrome, body: unknown): Html {
  const user = chrome.user;
  const content = html`${body}`;
  // Escaped text can never hold this attribute: only liveModule() writes it.
  const updates = user !== null && content.text.includes(' data-live="');
  const state = updates ? html`<p class="live-state" id="live-state" role="status" hidden></p>` : '';
  const top = html`<header class="top"><div><h1>${chrome.title}</h1>${chrome.sub === undefined ? '' : html`<p class="sub" id="page-sub">${chrome.sub}</p>`}${state}</div>${chrome.actions === undefined ? '' : html`<div class="actions">${chrome.actions}</div>`}</header>`;
  if (user === null) return htmlDocument(chrome.title, html`<div class="login"><div class="login-card${chrome.wide ? ' setup-card' : ''}">${brand()}${top}${content}</div></div>`);
  const nav = NAV.map(([key, label, path, name]) => html`<a class="nav-item${key === chrome.active ? ' on' : ''}" href="${path}"${key === chrome.active ? html` aria-current="page"` : ''}>${icon(name, 'nav-ico')}<span>${label}</span></a>`);
  return htmlDocument(chrome.title, html`<div class="shell">
<div class="side-wrap"><nav class="side" aria-label="主导航">
<div class="brand"><span class="logo" aria-hidden="true"></span><strong>circle-hub</strong></div>
<form class="search" role="search" method="get" action="/console/search">${icon('search')}<input type="search" name="q" maxlength="100" placeholder="搜索任务、知识、记录" aria-label="搜索"></form>
${nav}
<div class="me"><span class="avatar" aria-hidden="true">${[...user.name][0] ?? ''}</span><div class="me-t"><div>${user.name}</div><div class="me-r">${user.role}</div></div>
<form class="logout" method="post" action="/console/logout"><input type="hidden" name="csrf" value="${chrome.csrf ?? ''}"><button type="submit" class="icon-btn" aria-label="退出登录" title="退出登录">${icon('logout')}</button></form></div>
</nav></div>
<main class="content">${top}${content}</main>
</div>`, updates);
}

function brand(): Html {
  return html`<div class="row"><span class="logo lg" aria-hidden="true"></span><div><div class="brand-name">circle-hub</div><div class="sub">Circle 结果校验与共享知识服务</div></div></div>`;
}
