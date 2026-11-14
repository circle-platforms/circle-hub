import type { Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import { html, link, page, type Html, type PageChrome } from './html.ts';
import type { RebuildNeeded } from './reset.ts';
import { overviewPath } from './routes.ts';

/** What the console knows about the process serving it, for the Hub's state. */
export interface HubFacts {
  /** The release this process serves (release.json), null without one. */
  release: string | null;
  startedAt: Date;
  /** PEM of the built-in HTTPS server certificate, null when HTTPS is off. */
  certificate: string | null;
}

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  /** The chrome of a page: its title, and the place of the navigation, a line and buttons when the page has them. */
  chrome: (title: string, extra?: Pick<PageChrome, 'active' | 'sub' | 'hint' | 'actions' | 'crumbs'>) => PageChrome;
  /** The session's CSRF token, for the management forms (only the console's own requests carry one). */
  csrf?: string;
  /** The personal epoch read when rendering a write form. */
  personalEpoch?: string;
  /** What a knowledge action did, set by the action itself when only it knows (for example how many shares were merged). */
  feedback?: string;
  /** The request came over HTTPS (the built-in listener or the configured proxy). */
  secure?: boolean;
  /** The origin the browser reached (scheme and the Host the app accepted), for the Circle entry of this Hub. */
  origin?: string;
  /** The process serving the console, for the Hub's state. */
  hub?: HubFacts;
  /**
   * When set, the store shape does not match this binary (K11). Overview shows a banner; `/console/rebuild`
   * is the dedicated page. Codex fills the judgment; absent means the Hub is operating normally.
   */
  rebuildNeeded?: RebuildNeeded | null;
  /** Display name of a user id, cached for the request. */
  userName: (userId: string | null | undefined) => Promise<string>;
}

export interface PageResult {
  status: number;
  body: Html;
}

/**
 * The neutral answer for absent and forbidden alike (D05 R[3]): the same words whatever the path, so neither the object's
 * name nor its id shows. The MCP tools keep their own neutral text (UNAVAILABLE_MESSAGE).
 */
export const NEUTRAL = '该内容不存在或无权查看';

export function neutralPage(ctx: PageContext): PageResult {
  return { status: 404, body: page(ctx.chrome(NEUTRAL, {hint:'内容可能已删除，或当前账号没有查看权限，两种情况的显示相同。请返回总览或列表重新进入；仍需要时联系内容所有者或管理员确认。'}), html`<p>${link(overviewPath(), '返回总览')}</p>`) };
}

/**
 * The Circle settings entry for this Hub. Name and placeholders match Circle's `/hub` instructions so %HUB_URL% and
 * %HUB_TOKEN% expand (findings / N7). Without headers the client opens the MCP standard authorization page; with a
 * token the value stays a Circle secret for clients that do not use that flow.
 */
export function circleEntry(origin: string, token = true): string {
  const entry = {
    name: 'Hub',
    url: `${origin}/mcp`,
    transport: 'streamable_http',
    placeholders: { url: 'HUB_URL', token: 'HUB_TOKEN' },
  };
  return JSON.stringify({ mcp_servers: [token ? { ...entry, headers: { Authorization: 'Bearer ${secret:CIRCLE_HUB_TOKEN}' } } : entry] }, null, 2);
}

/** The origin a browser reached this console on: the scheme of the channel and the Host it sent. */
export function originOf(ctx: PageContext): string {
  return ctx.origin ?? `${ctx.secure ? 'https' : 'http'}://${ctx.url.host}`;
}
