import { connectionsPage } from './connections.ts';
import { healthPage } from './health.ts';
import { jobPage } from './manage.ts';
import { operationsPage } from './operations.ts';
import { overviewPage } from './overview.ts';
import { packPage, packsPage } from './packs.ts';
import { personalPublishPage } from './personal-packs.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import { knowledgePage, productPage, productSourcesPage, rootPage, runPage, runsPage, treePage, diffPage } from './pages.ts';
import { recordsPage } from './records.ts';
import { resultPage, resultsPage } from './results.ts';
import { searchPage } from './search.ts';
import { settingsPage } from './settings.ts';
import { sourceArchivePage } from './source-archive.ts';
import { spacePage, spaceDiffPage, spaceSourcePage, shareHistoryPage, batchSharePage } from './spaces.ts';
import { teamPage, teamsPage, teamDetailPage } from './team.ts';
import type { ConsoleSession } from './session.ts';
import { type ConsoleOptions, bridgeRun } from './console-http.ts';

type Route = (ctx: PageContext, rest: string[], options: ConsoleOptions, session: ConsoleSession) => Promise<PageResult>;

// Path literals until kit lands routes.ts (K3). Second admin page entries (calls/packs/resources/secrets/knowledge
// and bare /console/admin as the team page) are gone; POST /console/admin/do/<action> stays in index.ts.
export const ROUTES: Record<string, Route> = {
  overview: (ctx, rest) => (rest.length === 0 ? overviewPage(ctx) : Promise.resolve(neutralPage(ctx))),
  results: (ctx, rest) => (rest.length === 0 ? resultsPage(ctx) : rest.length === 1 ? resultPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  runs: (ctx, rest) => (rest.length === 0 ? runsPage(ctx) : rest.length === 1 ? runPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  knowledge: (ctx, rest) => {
    if (rest.length === 0) return knowledgePage(ctx);
    if (rest.length > 1) return Promise.resolve(neutralPage(ctx));
    const pages: Record<string, (c: PageContext) => Promise<PageResult>> = { product: productPage, root: rootPage, tree: treePage, diff: diffPage, space: spacePage, submissions: shareHistoryPage, 'space-diff': spaceDiffPage, source: spaceSourcePage, sources: sourceArchivePage, 'share-batch': batchSharePage, products: productSourcesPage };
    return Object.hasOwn(pages, rest[0]) ? pages[rest[0]](ctx) : Promise.resolve(neutralPage(ctx));
  },
  workflows: (ctx, rest, options) => (rest.length === 0 ? packsPage(ctx) : rest.join('/') === '-/publish' ? personalPublishPage(ctx, options.staging) : rest.length === 1 ? packPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  // The skills place (decision 151). List and detail both live under /console/skills (no packs fallback).
  skills: (ctx, rest) => (rest.length === 0 ? packsPage(ctx, 'skill') : rest.length === 1 ? packPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  connections: (ctx, rest) => (rest.length === 0 ? connectionsPage(ctx) : Promise.resolve(neutralPage(ctx))),
  records: (ctx, rest) => (rest.length === 0 ? recordsPage(ctx, '/console/records') : Promise.resolve(neutralPage(ctx))),
  search: (ctx, rest) => (rest.length === 0 ? searchPage(ctx) : Promise.resolve(neutralPage(ctx))),
  settings: (ctx, rest, options, session) => (rest.length === 0 ? settingsPage(ctx, bridgeRun(options, session)) : Promise.resolve(neutralPage(ctx))),
  health: (ctx, rest, options) => (rest.length === 0 && ctx.admin ? healthPage(ctx, options.observation, options.log) : Promise.resolve(neutralPage(ctx))),
  // interfaces §5.2: /console/team/<id> splits on prefix — tm_ → team detail, member id → member page.
  team: (ctx, rest) => {
    if (rest.length === 0) return teamPage(ctx);
    if (rest.length === 1) return rest[0].startsWith('tm_') ? teamDetailPage(ctx, rest[0]) : teamPage(ctx, rest[0]);
    return Promise.resolve(neutralPage(ctx));
  },
  // Alias kept for the 团队 tab list and older links; same pages as /console/team?tab=teams and /console/team/tm_….
  teams: (ctx, rest) => (rest.length === 0 ? teamsPage(ctx) : rest.length === 1 ? teamDetailPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  operations: (ctx, rest, options) => (rest.length <= 1 ? operationsPage(ctx, rest[0], options.jobs, options.staging) : Promise.resolve(neutralPage(ctx))),
  // Job progress pages only; bare /console/admin is no longer the team page.
  admin: (ctx, rest, options) => {
    if (!ctx.admin) return Promise.resolve(neutralPage(ctx));
    if (rest.length === 2 && rest[0] === 'jobs') return Promise.resolve(jobPage(ctx, options.jobs.get(rest[1])));
    return Promise.resolve(neutralPage(ctx));
  },
};
