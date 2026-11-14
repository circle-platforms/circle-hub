// Admin「测试环境」catalog on 连接 → 测试环境 (Boss 17:20): one registration form by name,
// list by name with assignment provenance. Reads a thin console port aligned with Codex's
// TestEnvironment draft; production wiring is not here yet. Missing port → explicit empty state.
// Manage ACTIONS: bed-register / bed-assign / bed-unassign (test-environment-actions.ts; Codex bed.*).
import type { Principal } from '../../records/api.ts';
import type { ExecutorView } from '../api.ts';
import { commands } from './commands.ts';
import { count, postForm, selectControl } from './components.ts';
import type { PageContext } from './context.ts';
import { html, table, type Html } from './html.ts';
import { actionLink, dialog, field } from './presentation.ts';
import { card } from './ui.ts';
import { heldOccupancyForEnvironment, unassignOccupancyFields } from './connections.ts';
import {
  bookingPrefixesSection,
  registrationDefaultsFromPrefix,
  type BookingPrefixRow,
  type BookingPrefixesPort,
} from './test-environments-prefixes.ts';

/** Admin POST targets registered in manage.ACTIONS (argv → circle-hub bed register|assign|unassign). */
export const TEST_ENVIRONMENT_ACTIONS = {
  register: 'bed-register',
  assign: 'bed-assign',
  unassign: 'bed-unassign',
} as const;

export type TestEnvironmentAssignmentSubject =
  | { kind: 'all' }
  | { kind: 'account'; name: string }
  | { kind: 'team'; name: string };

/** One grant on a test environment, with whether it is direct or inherited from a team. */
export type TestEnvironmentAssignmentRow = {
  subject: TestEnvironmentAssignmentSubject;
  source: 'direct' | 'inherited';
  /** Team name when source is inherited. */
  viaTeam?: string;
  /** Account ids whose held bookings this subject covers (for unassign confirmation). */
  holderIds: readonly string[];
};

/**
 * Console row aligned with Codex TestEnvironment / TestEnvironmentInput fields the page shows:
 * name, target, prefixes, resources (exact keys), executors (by name), owner (by name).
 * Internal env_/exe_/usr_ ids never appear in the markup.
 */
export type TestEnvironmentConsoleRow = {
  name: string;
  target: string;
  prefixes: readonly string[];
  resources: readonly string[];
  executors: readonly string[];
  owner: string;
  /** Owner account is disabled (Boss 17:21); still shown, marked. */
  ownerDisabled?: boolean;
  assignments: readonly TestEnvironmentAssignmentRow[];
  /** Exact keys matched against leases.view for unassign occupancy (prefixes and resource keys). */
  occupancyKeys: readonly string[];
};

export type TestEnvironmentNameChoice = { name: string };

/** Input for the fake/production register path (names only; no env_/exe_/usr_). */
export type TestEnvironmentRegisterInput = {
  name: string;
  target: string;
  prefixOrKey: string;
  executor?: string;
  owner: string;
};

/**
 * Thin console port for the catalog. Assembly will wrap records.testEnvironments;
 * until then tests supply a mutable fake and production leaves it absent.
 * register / assign / unassign mutate the fake so list「分给了谁」can be asserted without PostgreSQL.
 */
export type TestEnvironmentsConsolePort = {
  list(by: Principal): Promise<readonly TestEnvironmentConsoleRow[]>;
  executorChoices(by: Principal): Promise<readonly TestEnvironmentNameChoice[]>;
  ownerChoices(by: Principal): Promise<readonly TestEnvironmentNameChoice[]>;
  teamChoices(by: Principal): Promise<readonly TestEnvironmentNameChoice[]>;
  accountChoices(by: Principal): Promise<readonly TestEnvironmentNameChoice[]>;
  /** When false, the connections page keeps ENVIRONMENT_ASSIGNMENT_PREVIEW. Absent → unknown. */
  assignmentsEnforced?: boolean;
  register?(by: Principal, input: TestEnvironmentRegisterInput): Promise<void>;
  assign?(by: Principal, environment: string, subject: TestEnvironmentAssignmentSubject): Promise<void>;
  unassign?(by: Principal, environment: string, subject: TestEnvironmentAssignmentSubject): Promise<void>;
};

export type ServerDepsWithTestEnvironments = {
  testEnvironments?: TestEnvironmentsConsolePort;
  bookingPrefixes?: BookingPrefixesPort;
};

export function testEnvironmentsPort(ctx: PageContext): TestEnvironmentsConsolePort | undefined {
  return (ctx.deps as ServerDepsWithTestEnvironments).testEnvironments;
}

export function bookingPrefixesPort(ctx: PageContext): BookingPrefixesPort | undefined {
  return (ctx.deps as ServerDepsWithTestEnvironments).bookingPrefixes;
}

function subjectKey(subject: TestEnvironmentAssignmentSubject): string {
  if (subject.kind === 'all') return 'all';
  return `${subject.kind}:${subject.name}`;
}

function cloneRow(row: TestEnvironmentConsoleRow): TestEnvironmentConsoleRow {
  return {
    ...row,
    prefixes: [...row.prefixes],
    resources: [...row.resources],
    executors: [...row.executors],
    occupancyKeys: [...row.occupancyKeys],
    assignments: row.assignments.map((assignment) => ({
      ...assignment,
      subject: { ...assignment.subject },
      holderIds: [...assignment.holderIds],
    })),
  };
}

/**
 * In-memory fake for pure tests: register / assign / unassign change list rows so「分给了谁」updates.
 * Inherited rows are never written by assign (only direct grants); unassign removes matching direct rows.
 */
export function createMutableTestEnvironmentsPort(seed: {
  rows?: readonly TestEnvironmentConsoleRow[];
  executors?: readonly TestEnvironmentNameChoice[];
  owners?: readonly TestEnvironmentNameChoice[];
  teams?: readonly TestEnvironmentNameChoice[];
  accounts?: readonly TestEnvironmentNameChoice[];
  /** Account name → holder ids used when assigning an account (for unassign occupancy). */
  accountHolders?: Readonly<Record<string, readonly string[]>>;
  /** Team name → holder ids covered by that team grant. */
  teamHolders?: Readonly<Record<string, readonly string[]>>;
  assignmentsEnforced?: boolean;
} = {}): TestEnvironmentsConsolePort {
  const rows = (seed.rows ?? []).map(cloneRow);
  const executors = [...(seed.executors ?? [])];
  const owners = [...(seed.owners ?? [])];
  const teams = [...(seed.teams ?? [])];
  const accounts = [...(seed.accounts ?? [])];
  const accountHolders = seed.accountHolders ?? {};
  const teamHolders = seed.teamHolders ?? {};
  const findRow = (name: string): TestEnvironmentConsoleRow => {
    const row = rows.find((item) => item.name === name);
    if (row === undefined) throw new Error(`不存在：测试环境「${name}」`);
    return row;
  };
  return {
    assignmentsEnforced: seed.assignmentsEnforced,
    list: async () => rows.map(cloneRow),
    executorChoices: async () => [...executors],
    ownerChoices: async () => [...owners],
    teamChoices: async () => [...teams],
    accountChoices: async () => [...accounts],
    register: async (_by, input) => {
      if (rows.some((row) => row.name === input.name)) {
        throw new Error(`已被占用：测试环境名字「${input.name}」已登记`);
      }
      const isPrefix = input.prefixOrKey.endsWith('/');
      rows.push({
        name: input.name,
        target: input.target,
        prefixes: isPrefix ? [input.prefixOrKey] : [],
        resources: isPrefix ? [] : [input.prefixOrKey],
        executors: input.executor ? [input.executor] : [],
        owner: input.owner,
        assignments: [],
        occupancyKeys: [input.prefixOrKey],
      });
      if (input.executor && !executors.some((row) => row.name === input.executor)) {
        executors.push({ name: input.executor });
      }
      if (input.owner && !owners.some((row) => row.name === input.owner)) {
        owners.push({ name: input.owner });
      }
    },
    assign: async (_by, environment, subject) => {
      const row = findRow(environment);
      if (row.assignments.some((item) => item.source === 'direct' && subjectKey(item.subject) === subjectKey(subject))) {
        return;
      }
      const holderIds =
        subject.kind === 'account' ? [...(accountHolders[subject.name] ?? [])] :
        subject.kind === 'team' ? [...(teamHolders[subject.name] ?? [])] :
        [];
      row.assignments = [
        ...row.assignments,
        { subject: { ...subject }, source: 'direct', holderIds },
      ];
    },
    unassign: async (_by, environment, subject) => {
      const row = findRow(environment);
      const key = subjectKey(subject);
      row.assignments = row.assignments.filter(
        (item) => !(item.source === 'direct' && subjectKey(item.subject) === key),
      );
    },
  };
}

const EMPTY_CATALOG =
  '测试环境目录尚未接线。请管理员配置测试环境目录。';

function prefixesAndKeys(row: TestEnvironmentConsoleRow): string {
  const parts = [...row.prefixes, ...row.resources];
  return parts.length > 0 ? parts.join('、') : '—';
}

function assignmentSubjectText(subject: TestEnvironmentAssignmentSubject): string {
  if (subject.kind === 'all') return '全体';
  if (subject.kind === 'account') return `账户 ${subject.name}`;
  return `团队 ${subject.name}`;
}

function assignmentSourceText(row: TestEnvironmentAssignmentRow): string {
  if (row.source === 'direct') return '直接';
  return row.viaTeam ? `从团队「${row.viaTeam}」继承` : '从团队继承';
}

function assignmentCell(rows: readonly TestEnvironmentAssignmentRow[]): Html {
  if (rows.length === 0) return html`<span class="ch-meta">尚未分配</span>`;
  return html`${rows.map((row) => html`<div>${assignmentSubjectText(row.subject)} · ${assignmentSourceText(row)}</div>`)}`;
}

/** Occupancy view for heldOccupancyForEnvironment: target is the environment name; resources are occupancy keys. */
export function occupancyViewForEnvironment(row: TestEnvironmentConsoleRow): ExecutorView {
  return {
    id: 'exe_occupancy_placeholder',
    target: row.name,
    endpoint: '',
    enabled: true,
    resources: [...row.occupancyKeys],
  };
}

export type RegisterFormDefaults = {
  name?: string;
  target?: string;
  prefix_or_key?: string;
  owner?: string;
  executor?: string;
};

function registerForm(
  csrf: string,
  executors: readonly TestEnvironmentNameChoice[],
  owners: readonly TestEnvironmentNameChoice[],
  defaults: RegisterFormDefaults = {},
): Html {
  const ownerSelected = defaults.owner ?? '';
  const executorSelected = defaults.executor ?? '';
  const executorSelect = executors.length === 0
    ? selectControl('executor', [{ value: '', label: '尚无执行器' }], undefined, { required: true, disabled: true })
    : selectControl(
      'executor',
      executors.map((row) => ({ value: row.name, label: row.name, selected: row.name === executorSelected })),
      { value: '', label: '选择执行器', selected: executorSelected === '' },
      { required: true },
    );
  const ownerSelect = owners.length === 0
    ? selectControl('owner', [{ value: '', label: '尚无账户' }], undefined, { required: true, disabled: true })
    : selectControl(
      'owner',
      owners.map((row) => ({ value: row.name, label: row.name, selected: row.name === ownerSelected })),
      { value: '', label: '选择 owner', selected: ownerSelected === '' },
      { required: true },
    );
  return postForm({
    action: `/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.register}`,
    csrf,
    fields: html`
      ${field('名字', html`<input name="name" value="${defaults.name ?? ''}" required maxlength="200" autocomplete="off">`)}
      ${field('目标', html`<input name="target" value="${defaults.target ?? ''}" required maxlength="200" autocomplete="off">`)}
      ${field('前缀或键', html`<input name="prefix_or_key" value="${defaults.prefix_or_key ?? ''}" required maxlength="200" autocomplete="off">`, '写一条前缀（以 / 结尾）或一条精确键')}
      ${field('执行器', executorSelect, '按名字选择；不写内部编号')}
      ${field('owner', ownerSelect, '按账户名字选择')}
    `,
    submit: '登记测试环境',
    primary: true,
  });
}

function assignForm(
  csrf: string,
  environmentName: string,
  teams: readonly TestEnvironmentNameChoice[],
  accounts: readonly TestEnvironmentNameChoice[],
): Html {
  const teamSelect = teams.length === 0
    ? html``
    : field('团队', selectControl('team', teams.map((row) => ({ value: row.name, label: row.name })), { value: '', label: '（不填）' }), '与账户、全体互斥');
  const accountSelect = accounts.length === 0
    ? html``
    : field('账户', selectControl('user', accounts.map((row) => ({ value: row.name, label: row.name })), { value: '', label: '（不填）' }), '与团队、全体互斥');
  if (teams.length === 0 && accounts.length === 0) {
    return html`<p class="ch-meta">尚无团队或启用账户，无法分配。</p>`;
  }
  return postForm({
    action: `/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.assign}`,
    csrf,
    fields: html`
      <input type="hidden" name="environment" value="${environmentName}">
      <label class="check" data-wide-field><input type="checkbox" name="all" value="1"> 全体</label>
      ${teamSelect}${accountSelect}
    `,
    submit: '分配',
    primary: true,
  });
}

async function unassignControls(
  ctx: PageContext,
  row: TestEnvironmentConsoleRow,
  assignment: TestEnvironmentAssignmentRow,
  index: number,
): Promise<{ cell: Html; dialog: Html }> {
  const dialogId = `unassign-test-environment-${index}`;
  const subjectLabel = assignmentSubjectText(assignment.subject);
  const occupancy = await heldOccupancyForEnvironment(
    ctx,
    occupancyViewForEnvironment(row),
    new Set(assignment.holderIds),
  );
  const subjectFields =
    assignment.subject.kind === 'all' ? html`<input type="hidden" name="all" value="1">` :
    assignment.subject.kind === 'team' ? html`<input type="hidden" name="team" value="${assignment.subject.name}"><input type="hidden" name="team_label" value="${assignment.subject.name}">` :
    html`<input type="hidden" name="user" value="${assignment.subject.name}"><input type="hidden" name="user_label" value="${assignment.subject.name}">`;
  return {
    cell: actionLink(`#${dialogId}`, '撤回…', 'danger'),
    dialog: dialog(
      dialogId,
      `撤回测试环境分配：${row.name}`,
      html`<p>${commands.executorUnassignConsequence}</p><p class="ch-meta">对象：${subjectLabel}</p>`,
      postForm({
        action: `/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.unassign}`,
        csrf: ctx.csrf ?? '',
        fields: html`<input type="hidden" name="environment" value="${row.name}">${subjectFields}${unassignOccupancyFields(occupancy)}`,
        submit: '确认撤回',
        danger: true,
      }),
    ),
  };
}

/**
 * Admin catalog body for 连接 → 测试环境. Callers keep readiness and the preview notice outside.
 * Non-admins get a short pointer to 我能做的事 (members do not manage the catalog here).
 */
export async function testEnvironmentsPanel(ctx: PageContext): Promise<Html> {
  if (!ctx.admin) {
    return html`<p class="ch-meta" data-test-environments="member">测试环境目录仅管理员可登记与分配；已分配的测试环境与占用见「我能做的事」。</p>`;
  }
  const port = testEnvironmentsPort(ctx);
  if (port === undefined) {
    return html`<div class="ch-stack" data-test-environments="unwired">
      ${card({ title: '测试环境' }, html`<p class="ch-meta">${EMPTY_CATALOG}</p>`)}
    </div>`;
  }
  const prefixesPort = bookingPrefixesPort(ctx);
  const [rows, executors, owners, teams, accounts, prefixRows] = await Promise.all([
    port.list(ctx.principal),
    port.executorChoices(ctx.principal),
    port.ownerChoices(ctx.principal),
    port.teamChoices(ctx.principal),
    port.accountChoices(ctx.principal),
    prefixesPort ? prefixesPort.list() : Promise.resolve([] as readonly BookingPrefixRow[]),
  ]);
  const ordered = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const confirmations: Html[] = [];
  const tableRows: unknown[][] = [];
  let unassignIndex = 0;
  for (const row of ordered) {
    const ownerCell = row.ownerDisabled ? html`${row.owner}<div class="ch-meta">owner 已停用</div>` : row.owner;
    const assignActions: Html[] = [assignForm(ctx.csrf ?? '', row.name, teams, accounts)];
    for (const assignment of row.assignments) {
      if (assignment.source !== 'direct') continue;
      const control = await unassignControls(ctx, row, assignment, unassignIndex++);
      confirmations.push(control.dialog);
      assignActions.push(control.cell);
    }
    tableRows.push([
      row.name,
      row.target,
      prefixesAndKeys(row),
      row.executors.length > 0 ? row.executors.join('、') : '—',
      ownerCell,
      assignmentCell(row.assignments),
      html`<div class="ch-stack" data-test-environment-actions>${assignActions}</div>`,
    ]);
  }
  const csrf = ctx.csrf ?? '';
  const selectedPrefix = ctx.url.searchParams.get('register_prefix');
  const prefixesSection = prefixesPort === undefined
    ? html``
    : bookingPrefixesSection(prefixRows, {
      pagePath: '/console/connections',
      pageParams: { tab: 'environments' },
      selectedPrefix,
      formFieldsFor: (selected) => {
        const defaults = registrationDefaultsFromPrefix(selected);
        const ownerList = owners.some((item) => item.name === defaults.owner)
          ? owners
          : [...owners, { name: defaults.owner }];
        return registerForm(csrf, executors, ownerList, {
          prefix_or_key: defaults.prefix,
          owner: defaults.owner,
        });
      },
    });
  return html`<div class="ch-stack" data-test-environments="ready">
${card(
  { title: '测试环境', hint: `共 ${count(ordered.length)} 个；按名字显示，不露内部编号。登记、分配各一张表单。` },
  table(
    ['名字', '目标', '前缀 / 键', '执行器', 'owner', '分给了谁', ''],
    tableRows,
    { title: '尚无测试环境', text: '用下方表单登记一个测试环境（一张表单一次提交）。' },
  ),
)}
${card(
  { title: '登记测试环境', hint: '名字、目标、前缀或键、执行器、owner；不上主机、不传文件、不写内部编号。' },
  registerForm(csrf, executors, owners),
)}
${prefixesSection}
${confirmations}
</div>`;
}

/** How many catalog rows the tab badge shows; 0 when the port is absent or the read fails. */
export async function testEnvironmentsCount(ctx: PageContext): Promise<number> {
  const port = testEnvironmentsPort(ctx);
  if (port === undefined || !ctx.admin) return 0;
  try {
    return (await port.list(ctx.principal)).length;
  } catch {
    return 0;
  }
}
