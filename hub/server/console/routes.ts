/**
 * Typed path constructors for every console page. Pages and navigation build links from these;
 * tests that assert addresses keep string literals so the constants stay checked.
 * Workflow list/detail: /console/workflows[/<id>]. Skills: /console/skills[/<id>].
 * /console/packs page paths are retired. /console/api/*, OAuth/device/setup/authorize/login/logout stay.
 * /console/results and POST /console/admin/do/* remain today.
 */

const enc = (segment: string): string => encodeURIComponent(segment);

export const overviewPath = (): string => '/console/overview';
export const searchPath = (): string => '/console/search';

export const runsPath = (): string => '/console/runs';
export const runPath = (runId: string): string => `/console/runs/${enc(runId)}`;

export const resultsPath = (): string => '/console/results';
export const resultPath = (runId: string): string => `/console/results/${enc(runId)}`;

export const workflowsPath = (): string => '/console/workflows';
export const workflowPath = (id: string): string => `/console/workflows/${enc(id)}`;

export const skillsPath = (): string => '/console/skills';
export const skillPath = (id: string): string => `/console/skills/${enc(id)}`;

export const knowledgePath = (): string => '/console/knowledge';
export const knowledgeProductPath = (): string => '/console/knowledge/product';
export const knowledgeProductsPath = (): string => '/console/knowledge/products';
export const knowledgeRootPath = (): string => '/console/knowledge/root';
export const knowledgeTreePath = (): string => '/console/knowledge/tree';
export const knowledgeDiffPath = (): string => '/console/knowledge/diff';
export const knowledgeSpacePath = (): string => '/console/knowledge/space';
export const knowledgeSpaceDiffPath = (): string => '/console/knowledge/space-diff';
export const knowledgeSourcePath = (): string => '/console/knowledge/source';
export const knowledgeSourcesPath = (): string => '/console/knowledge/sources';
export const knowledgeSubmissionsPath = (): string => '/console/knowledge/submissions';
export const knowledgeShareBatchPath = (): string => '/console/knowledge/share-batch';
export const knowledgeDoPath = (action: string): string => `/console/knowledge/do/${enc(action)}`;
export const knowledgeDownloadPath = (): string => '/console/knowledge/download';

export const connectionsPath = (): string => '/console/connections';
export const recordsPath = (): string => '/console/records';
export const teamPath = (memberId?: string): string => (memberId === undefined ? '/console/team' : `/console/team/${enc(memberId)}`);
/** Collaborative teams (K6); distinct from /console/team member pages so tm_ ids never collide with user ids. */
export const teamsPath = (): string => '/console/teams';
export const teamDetailPath = (teamId: string): string => `/console/teams/${enc(teamId)}`;
export const settingsPath = (): string => '/console/settings';
export const healthPath = (): string => '/console/health';

export const operationsPath = (): string => '/console/operations';
export const operationsPackPath = (): string => '/console/operations/pack';
export const operationsKnowledgePath = (): string => '/console/operations/knowledge';
export const operationsMemberPath = (): string => '/console/operations/member';
export const operationsSystemPath = (): string => '/console/operations/system';

export const adminDoPath = (action: string): string => `/console/admin/do/${enc(action)}`;

export const loginPath = (): string => '/console/login';
export const logoutPath = (): string => '/console/logout';
export const passwordPath = (): string => '/console/password';
export const setupPath = (): string => '/console/setup';
export const authorizePath = (): string => '/console/authorize';
export const authorizeRequestPath = (id: string): string => `/console/authorize/${enc(id)}`;
export const devicePath = (): string => '/console/device';
export const faviconPath = (): string => '/console/favicon.svg';
