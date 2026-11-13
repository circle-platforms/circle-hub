/**
 * K11 (decisions-1600 / answers-cursor 17:15): console surfaces for「重置和重建」.
 * Settings offers scoped reset (same command as `circle-hub reset`); a dedicated page covers the
 *「需要重建」state when the running Hub finds an incompatible store. Command argv and incompatibility
 * judgment come from Codex (`interfaces-reset.md`); until that lands, pages and copy are ready and the
 * optional `rebuildNeeded` on the page context drives the banner and dedicated route.
 */
import { adminDoPath, overviewPath, settingsPath, setupPath } from './routes.ts';
import { errorLine, postForm, selectControl } from './components.ts';
import { field } from './presentation.ts';
import { code, html, link, page, type Html } from './html.ts';
import { box, callout, card } from './ui.ts';
import type { PageContext, PageResult } from './context.ts';

/** What the administrator types to confirm a destructive reset (plain language, not an internal code). */
export const RESET_CONFIRM_WORD = '重建';

/** Reset scopes offered on the settings page (aligned with answers-codex 17:15). */
export const RESET_SCOPES = [
  {
    value: 'runs',
    label: '运行历史',
    clears: '清掉任务运行、提交、检查结果和调用记录。',
    keeps: '留下账户、团队、分配、业务系统、执行器、知识和已发布的包。',
  },
  {
    value: 'knowledge',
    label: '知识',
    clears: '清掉知识库里的条目、原文、记忆和相关版本记录。',
    keeps: '留下账户、团队、分配、业务系统、执行器、包和运行历史。',
  },
  {
    value: 'packs',
    label: '包',
    clears: '清掉已发布的工作流与技能包及其分配。',
    keeps: '留下账户、团队、业务系统、执行器、知识和运行历史。',
  },
  {
    value: 'config',
    label: '配置',
    clears: '清掉账户、团队、分配、业务系统、执行器和普通变量登记。',
    keeps: '留下知识、已发布的包和运行历史；凭据的加密内容仍在密钥库里，按名字接回。',
  },
  {
    value: 'all',
    label: '全部初始化',
    clears: '清掉上述全部内容，回到首次设置前的空库。',
    keeps: '密钥库不动；归档里仍可查看重置前的库。',
  },
] as const;

export type ResetScope = (typeof RESET_SCOPES)[number]['value'];

export function isResetScope(value: string): value is ResetScope {
  return RESET_SCOPES.some((row) => row.value === value);
}

/** Why this Hub needs a rebuild; Codex fills this when the store shape does not match the binary. */
export interface RebuildNeeded {
  /** One short sentence for the administrator. */
  reason: string;
  /** Optional extra lines (which check failed); shown as plain text, never internal table names alone. */
  detail?: string;
}

const ARCHIVE_NOTE =
  '执行前会先做一份校验过的备份，并把当前库改名归档到数据目录里（不直接删除）。页面结果里会写归档位置。密钥库（凭据的加密内容）不动；重置后业务系统和执行器仍按名字接回凭据。';

const KEEP_CONFIG_NOTE =
  '勾选后，程序会在重置前导出当前配置（账户与令牌的散列、团队、分配、业务系统、执行器等，不含任何凭据明文），重置后再自动写回。库的结构已经和本版本对不上、导不出来时，只能选「归档并初始化」或带着定义文件恢复。';

/** Scope explanations as a short list for the settings card. */
function scopeHelp(): Html {
  return html`<ul class="ch-meta">${RESET_SCOPES.map((row) => html`<li><b>${row.label}</b>：${row.clears}${row.keeps}</li>`)}</ul>`;
}

/**
 * Admin-only「重置和重建」card for the Hub tab of settings. Posts to the same bridge action as
 * `circle-hub reset` once Codex registers the command.
 */
export function resetRebuildSection(ctx: PageContext): Html {
  if (!ctx.admin) return html``;
  const selected = ctx.url.searchParams.get('reset_scope') ?? 'runs';
  const keepOn = ctx.url.searchParams.get('keep_config') === '1';
  const fields = html`${field(
    '范围',
    selectControl(
      'scope',
      RESET_SCOPES.map((row) => ({ value: row.value, label: row.label, selected: row.value === selected })),
      undefined,
      { required: true },
    ),
    '只清所选范围；全部初始化会回到空库。',
  )}
<label class="check" data-wide-field><input type="checkbox" name="keep_config" value="1"${keepOn ? html` checked` : ''}> 保留配置重建</label>
<p class="ch-meta">${KEEP_CONFIG_NOTE}</p>
${field(
    '确认',
    html`<input name="confirm" autocomplete="off" required maxlength="16" placeholder="${RESET_CONFIRM_WORD}">`,
    `请输入「${RESET_CONFIRM_WORD}」再执行；这会归档当前库并按所选范围清空。`,
  )}
<p class="ch-meta">${ARCHIVE_NOTE}</p>`;
  return html`<section id="reset-rebuild">${card(
    {
      title: '重置和重建',
      hint: '更新后不兼容、配置乱了、或想从头来时用这里。与命令行 circle-hub reset 是同一条命令。',
    },
    html`${callout('warn', html`<span>只有管理员可以执行。执行前请确认没有其他人正在写入 Hub。</span>`)}
${scopeHelp()}
${postForm({
  action: adminDoPath('reset'),
  csrf: ctx.csrf ?? '',
  fields,
  submit: '归档并按所选范围重建',
  danger: true,
})}`)}</section>`;
}

/** Banner on the overview when the process is in「需要重建」. */
export function rebuildNeededBanner(needed: RebuildNeeded): Html {
  return callout(
    'warn',
    html`<span><b>需要重建。</b>${needed.reason} ${link('/console/rebuild', '打开需要重建页面')}</span>`,
  );
}

/**
 * The only console page meant for an incompatible store: explain, offer archive-and-init or restore-from-definition,
 * then point at first-time setup after a successful reset.
 */
export function needsRebuildPage(ctx: PageContext, needed: RebuildNeeded | null): PageResult {
  const reason = needed?.reason ?? '当前数据与本版本对不上，不能继续按平常方式使用。';
  const detail = needed?.detail;
  const confirmField = field(
    '确认',
    html`<input name="confirm" autocomplete="off" required maxlength="16" placeholder="${RESET_CONFIRM_WORD}">`,
    `请输入「${RESET_CONFIRM_WORD}」以归档当前库并全部初始化。`,
  );
  const archiveForm = postForm({
    action: adminDoPath('reset'),
    csrf: ctx.csrf ?? '',
    fields: html`<input type="hidden" name="scope" value="all">${confirmField}
<p class="ch-meta">${ARCHIVE_NOTE}</p>`,
    submit: '归档并初始化',
    danger: true,
  });
  const restoreHint = html`<p>若你已有一份部署定义文件（账户、团队、分配、业务系统、执行器和要发布的包），先完成「归档并初始化」，再到运行 Hub 的服务器上执行 ${code('circle-hub apply')}，把定义写回去；凭据仍按名字从密钥库接回。</p>
<p class="ch-meta">定义文件的写法见部署说明；本页不上传文件，避免把明文凭据带进浏览器。</p>`;
  const body = html`${box(
    { title: '需要重建', hint: '这个 Hub 的数据结构和当前程序版本不一致时，只开放本页和健康检查。' },
    html`${callout('warn', html`<span>${reason}</span>`)}
${detail ? html`<p class="ch-meta">${detail}</p>` : ''}
${ctx.admin
  ? html`<section class="ch-section"><h2 class="ch-section-label">可选做法</h2>
${card({ title: '归档并初始化' }, html`<p>把当前库改名归档，再建一份空库。完成后按提示做首次设置。</p>${archiveForm}`)}
${card({ title: '用定义文件恢复' }, restoreHint)}
</section>`
  : html`<p>请联系管理员在本页完成重建，或到运行 Hub 的服务器上执行 ${code('circle-hub reset')}。</p>`}
<p>${link(overviewPath(), '返回总览')} · ${link(settingsPath() + '?tab=hub#reset-rebuild', '打开设置里的重置和重建')} · ${link(setupPath(), '首次设置')}</p>`,
  )}`;
  return {
    status: 200,
    body: page(ctx.chrome('需要重建', {
      active: 'settings',
      hint: '数据与本版本不兼容时的重建入口；平常重置也在设置页。',
    }), body),
  };
}
