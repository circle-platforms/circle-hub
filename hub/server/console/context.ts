import type { Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import { html, link, page, type Html, type PageChrome } from './html.ts';
import type { RebuildNeeded } from './reset.ts';
import { overviewPath } from './routes.ts';

export interface HubFacts {
  release: string | null;
  startedAt: Date;
  certificate: string | null;
}

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  chrome: (title: string, extra?: Pick<PageChrome, 'active' | 'sub' | 'hint' | 'actions' | 'crumbs'>) => PageChrome;
  csrf?: string;
  personalEpoch?: string;
  feedback?: string;
  secure?: boolean;
  origin?: string;
  hub?: HubFacts;
  rebuildNeeded?: RebuildNeeded | null;
  userName: (userId: string | null | undefined) => Promise<string>;
}

export interface PageResult {
  status: number;
  body: Html;
}

export const NEUTRAL = '该内容不存在或无权查看';

export function neutralPage(ctx: PageContext): PageResult {
  return { status: 404, body: page(ctx.chrome(NEUTRAL, {hint:'内容可能已删除，或当前账号没有查看权限，两种情况的显示相同。请返回总览或列表重新进入；仍需要时联系内容所有者或管理员确认。'}), html`<p>${link(overviewPath(), '返回总览')}</p>`) };
}

export function circleEntry(origin: string, token = true): string {
  const entry = {
    type: 'http',
    url: `${origin}/mcp`,
    placeholders: { url: 'HUB_URL', token: 'HUB_TOKEN' },
  };
  return JSON.stringify(
    {
      mcpServers: {
        Hub: token ? { ...entry, headers: { Authorization: 'Bearer ${secret:CIRCLE_HUB_TOKEN}' } } : entry,
      },
    },
    null,
    2,
  );
}

export function originOf(ctx: PageContext): string {
  return ctx.origin ?? `${ctx.secure ? 'https' : 'http'}://${ctx.url.host}`;
}
