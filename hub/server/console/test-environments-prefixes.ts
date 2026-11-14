// Console column「不是测试环境的预订前缀」(Boss 17:20 #3 / answers-codex 17:06·17:10).
// Fake-port rows only: prefix + owner name; holders / workflowAssignees feed the register form disclosure.
import { href, html, table, type Html } from './html.ts';
import { actionLink, dialog } from './presentation.ts';
import { card } from './ui.ts';

/** Recent holder of keys under this booking prefix (display name only). */
export type BookingPrefixHolder = {
  name: string;
  /** ISO time when known; omitted when the fake port only has a name. */
  since?: string;
};

/** Account or team that still has a related workflow assignment (display names). */
export type BookingPrefixWorkflowAssignee = {
  kind: 'account' | 'team';
  name: string;
};

/**
 * Console / fake-port row for a confirmed non-environment booking namespace.
 * ownerName is the account name from deployment@3 bookingPrefixes — never usr_….
 */
export type BookingPrefixRow = {
  prefix: string;
  ownerName: string;
  holders?: readonly BookingPrefixHolder[];
  workflowAssignees?: readonly BookingPrefixWorkflowAssignee[];
};

/** Thin read port for the prefixes column; production maps records booking-prefix entries + name resolve. */
export type BookingPrefixesPort = {
  list(): Promise<readonly BookingPrefixRow[]>;
};

export const BOOKING_PREFIXES_SECTION = '不是测试环境的预订前缀';
export const REGISTER_AS_TEST_ENVIRONMENT = '登记成测试环境';
export const PREFIX_USAGE_HEADING = '现在谁在用这个前缀';

/** Dialog / hash id shared with the formal registration form on the 测试环境 page. */
export const REGISTER_FROM_PREFIX_DIALOG = 'register-from-prefix';

/** Prefill values for the same registration form the formal「登记」entry uses. */
export function registrationDefaultsFromPrefix(row: BookingPrefixRow): {
  prefix: string;
  owner: string;
} {
  return { prefix: row.prefix, owner: row.ownerName };
}

/**
 * Link into the shared register form with this prefix selected.
 * `pagePath` is the skeleton page path (for example `/console/connections` with tab=environments).
 */
export function registerAsTestEnvironmentHref(
  pagePath: string,
  prefix: string,
  params: Record<string, string | number | null | undefined> = {},
): string {
  return `${href(pagePath, { ...params, register_prefix: prefix })}#${REGISTER_FROM_PREFIX_DIALOG}`;
}

function formatSince(since: string | undefined): string {
  if (since === undefined) return '';
  return ` · 自 ${since}`;
}

/** Disclosure block shown on the shared registration form when opened from this column. */
export function prefixUsageBlock(row: BookingPrefixRow): Html {
  const holders = row.holders ?? [];
  const assignees = row.workflowAssignees ?? [];
  const holderLines = holders.length === 0
    ? html`<p class="ch-meta" data-prefix-holders="none">最近没有读到持有者。</p>`
    : html`<ul data-prefix-holders="held">${holders.map((holder) => html`<li>${holder.name}${formatSince(holder.since)}</li>`)}</ul>`;
  const assigneeLines = assignees.length === 0
    ? html`<p class="ch-meta" data-prefix-workflow-assignees="none">没有读到相关工作流分配的账户或团队。</p>`
    : html`<ul data-prefix-workflow-assignees="held">${assignees.map((row) => html`<li>${row.kind === 'team' ? '团队' : '账户'} ${row.name}</li>`)}</ul>`;
  return html`<section data-prefix-usage aria-label="${PREFIX_USAGE_HEADING}">
<h3 class="ch-panel-title">${PREFIX_USAGE_HEADING}</h3>
<p class="ch-meta">最近持有者；有相关工作流分配的账户或团队。登记成测试环境后默认不开放，不自动授予。</p>
<p class="ch-meta">最近持有者</p>
${holderLines}
<p class="ch-meta">有相关工作流分配</p>
${assigneeLines}
</section>`;
}

/**
 * Dialog that reuses the formal registration field set (caller supplies `formFields`) and shows who uses the prefix.
 * Skeleton page wires the same fields as the primary「登记」form.
 */
export function registerFromPrefixDialog(
  row: BookingPrefixRow,
  formFields: Html,
  actions: Html = html``,
): Html {
  const defaults = registrationDefaultsFromPrefix(row);
  return dialog(
    REGISTER_FROM_PREFIX_DIALOG,
    REGISTER_AS_TEST_ENVIRONMENT,
    html`${prefixUsageBlock(row)}
<p class="ch-meta">前缀「${defaults.prefix}」、owner「${defaults.owner}」已填入下方与正式登记同一张表单；补目标和执行器后提交。不上主机、不传文件。</p>
${formFields}`,
    actions,
  );
}

/** Admin-only column: prefix + owner name, with an entry to open the shared registration form. */
export function bookingPrefixesSection(
  rows: readonly BookingPrefixRow[],
  options: {
    pagePath: string;
    pageParams?: Record<string, string | number | null | undefined>;
    /** When set, each row's register link opens this dialog id on the same page. */
    selectedPrefix?: string | null;
    formFieldsFor?: (row: BookingPrefixRow) => Html;
    formActionsFor?: (row: BookingPrefixRow) => Html;
  },
): Html {
  const selected = options.selectedPrefix
    ? rows.find((row) => row.prefix === options.selectedPrefix) ?? null
    : null;
  const tableBody = table(
    ['前缀', 'owner', ''],
    rows.map((row) => [
      row.prefix,
      row.ownerName,
      actionLink(
        registerAsTestEnvironmentHref(options.pagePath, row.prefix, options.pageParams),
        REGISTER_AS_TEST_ENVIRONMENT,
        'secondary',
      ),
    ]),
    {
      title: '当前没有不是测试环境的预订前缀',
      text: '有 owner、没有目标的预订前缀会列在这里；它们不是测试环境，不受新的测试环境分配守卫管。',
    },
  );
  return html`<div data-booking-prefixes>
${card(
  {
    title: BOOKING_PREFIXES_SECTION,
    hint: '有 owner、没有目标、不是测试环境的预订前缀；把其中一条登记成测试环境时用栏内入口，表单与正式登记相同。',
  },
  tableBody,
)}
${selected && options.formFieldsFor
  ? registerFromPrefixDialog(selected, options.formFieldsFor(selected), options.formActionsFor?.(selected) ?? html``)
  : ''}
</div>`;
}
