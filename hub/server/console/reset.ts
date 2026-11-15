/**
 * K11 console surfaces for「重置和重建」and「需要重建」.
 * Ordinary mode posts settings preview to `/console/admin/do/reset` (Codex createApp routes it to the
 * rebuild handler with authenticateAdmin + ResetPorts). Incompatible mode uses `/console/rebuild/*`.
 * Status path: `/console/reset/status/<UUID>`. Orchestration/apply/export live on the server bridge.
 */
import { RESET_ALL_LABEL, RESET_SCOPE, RESET_SCOPE_LABEL, type ResetScope } from '../../../contracts/src/reset.ts';
import type { RebuildConsoleContext } from '../rebuild-http.ts';
import type { RebuildNeeded } from '../rebuild-state.ts';
import {
  adminDoPath,
  overviewPath,
  rebuildAuthorizePath,
  rebuildExecutePath,
  rebuildNewActionPath,
  rebuildPath,
  rebuildPreviewPath,
  resetStatusPath,
  settingsPath,
  setupPath,
} from './routes.ts';
import { postForm, selectControl, submitButton } from './components.ts';
import { field } from './presentation.ts';
import { code, html, link, page, type Html } from './html.ts';
import { box, callout, card } from './ui.ts';
import type { PageContext, PageResult } from './context.ts';

export type { RebuildNeeded };
export type { RebuildConsoleContext };

/** What the administrator types to confirm a destructive reset. */
export const RESET_CONFIRM_WORD = '重建';

/** Selector values are the generated reset_scope axis (including all); do not append a handwritten literal. */
export type ResetChoice = ResetScope;

export const RESET_SCOPES: readonly { value: ResetChoice; label: string; clears: string; keeps: string }[] = [
  {
    value: 'history',
    label: RESET_SCOPE_LABEL.history,
    clears: '清掉任务运行、提交、检查结果和调用记录。',
    keeps: '留下账户、团队、分配、业务系统、执行器、知识和已发布的包。',
  },
  {
    value: 'knowledge',
    label: RESET_SCOPE_LABEL.knowledge,
    clears: '清掉知识库里的条目、原文、记忆和相关版本记录。',
    keeps: '留下账户、团队、分配、业务系统、执行器、包和运行历史。',
  },
  {
    value: 'packs',
    label: RESET_SCOPE_LABEL.packs,
    clears: '清掉已发布的工作流与技能包及其分配。',
    keeps: '留下账户、团队、业务系统、执行器、知识和运行历史。',
  },
  {
    value: 'config',
    label: RESET_SCOPE_LABEL.config,
    clears: '清掉账户、团队、分配、业务系统、执行器和普通变量登记。',
    keeps: '留下知识、已发布的包和运行历史；凭据的加密内容仍在密钥库里，按名字接回。',
  },
  {
    value: 'all',
    label: RESET_ALL_LABEL,
    clears: '清掉上述全部内容，回到首次设置前的空库。',
    keeps: '密钥库不动；归档里仍可查看重置前的库。',
  },
];

export function isResetScope(value: string): value is ResetChoice {
  return (RESET_SCOPE as readonly string[]).includes(value);
}

const ARCHIVE_NOTE =
  '执行前会先做一份校验过的备份，并把当前库改名归档到数据目录里（不直接删除）。页面结果里会写归档位置。密钥库（凭据的加密内容）不动；重置后业务系统和执行器仍按名字接回凭据。';

const KEEP_CONFIG_NOTE =
  '勾选后，程序会在重置前导出当前配置（账户与令牌的散列、团队、分配、业务系统、执行器等，不含任何凭据明文），重置后再自动写回。库的结构已经和本版本对不上、导不出来时，只能选「归档并初始化」或带着定义文件恢复。';

const PAGE_HINT = '数据与本版本不兼容时的重建入口；平常重置也在设置页。';
const ASYNC_NOTE = '预检正确后会打开确认页；真正执行走后台重建，不会在网页请求里同步停服。';

function scopeHelp(): Html {
  return html`<ul class="ch-meta">${RESET_SCOPES.map((row) => html`<li><b>${row.label}</b>：${row.clears}${row.keeps}</li>`)}</ul>`;
}

/**
 * Admin-only「重置和重建」card. Posts to `/console/admin/do/reset` (fields Codex rebuild-http accepts:
 * csrf, confirm, scope, keep_config). Response is the preview page with execute controls.
 */
export function resetRebuildSection(ctx: PageContext): Html {
  if (!ctx.admin) return html``;
  const selected = ctx.url.searchParams.get('reset_scope') ?? 'history';
  const keepOn = ctx.url.searchParams.get('keep_config') === '1' || ctx.url.searchParams.get('keep-config') === '1';
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
    `请输入「${RESET_CONFIRM_WORD}」再预检。`,
  )}
<p class="ch-meta">${ARCHIVE_NOTE}</p>
<p class="ch-meta">${ASYNC_NOTE}</p>`;
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
  submit: '预检所选范围',
  danger: true,
})}`)}</section>`;
}

export function rebuildNeededBanner(needed: RebuildNeeded): Html {
  return callout(
    'warn',
    html`<span><b>需要重建。</b>${needed.reason} ${link(rebuildPath(), '打开需要重建页面')}</span>`,
  );
}

function authorizeForm(csrf: string, loginNonce?: string): Html {
  return postForm({
    action: rebuildAuthorizePath(),
    csrf,
    fields: html`${loginNonce === undefined ? '' : html`<input type="hidden" name="nonce" value="${loginNonce}">`}
${field('本机维护码', html`<input name="setup_code" autocomplete="off" required maxlength="128">`, '在运行 Hub 的服务器上执行 circle-hub setup-code --rebuild 后，把只显示一次的码贴到这里。')}`,
    submit: '授权并继续',
    primary: true,
  });
}

function operationPanel(operation: NonNullable<RebuildConsoleContext['operation']>): Html {
  const statusHref = resetStatusPath(operation.operationId);
  if (operation.completed) {
    if (operation.error) {
      return callout('warn', html`<span>重建未完成：${operation.error.reason} ${operation.error.nextAction}</span>`);
    }
    const archive = operation.report?.archive;
    const backup = operation.report?.backup;
    const notices = operation.report?.notices ?? [];
    return html`${callout('info', html`<span>重建已结束。${archive ? html`归档：${code(archive)}。` : ''}${backup ? html`备份：${code(backup)}。` : ''}请继续首次设置。</span>`)}
${notices.length === 0 ? '' : html`<ul class="ch-meta">${notices.map((row) => html`<li>${row.reason} ${row.nextAction}</li>`)}</ul>`}
<p>${link(setupPath(), '首次设置')} · ${link(overviewPath(), '返回总览')}</p>`;
  }
  return html`${callout('info', html`<span>重建进行中。可关闭本页；进度仍会继续。状态编号 ${code(operation.operationId)}。</span>`)}
<p class="ch-meta">请每约 2 秒 ${link(rebuildPath() + '?operation=' + encodeURIComponent(operation.operationId), '刷新本页')}，或打开 ${link(statusHref, '状态')}（需同一已验证会话）。</p>`;
}

function planPanel(context: RebuildConsoleContext): Html {
  const plan = context.plan;
  if (!plan) return html``;
  const blocked = plan.blocked;
  const counts = plan.counts.map((row) => html`<li>${RESET_SCOPE_LABEL[row.scope]}：保留 ${row.retained}，清除 ${row.cleared === null ? '待定' : row.cleared}</li>`);
  return html`<section class="ch-section"><h2 class="ch-section-label">预检结果</h2>
${blocked.length ? callout('warn', html`<span>当前不能执行：${blocked.map((row) => row.reason).join('；')}</span>`) : callout('info', html`<span>预检正确，可以确认执行。</span>`)}
<ul class="ch-meta">${counts}</ul>
</section>`;
}

function authorizedRebuildBody(context: RebuildConsoleContext): Html {
  const reason = context.rebuildNeeded?.reason ?? '当前数据与本版本对不上，不能继续按平常方式使用。';
  const detail = context.rebuildNeeded?.detail;
  if (context.operation) {
    return html`${callout('warn', html`<span>${reason}</span>`)}${detail ? html`<p class="ch-meta">${detail}</p>` : ''}${operationPanel(context.operation)}`;
  }

  const actionId = context.actionId;
  const previewFields = html`${actionId === undefined ? '' : html`<input type="hidden" name="actionId" value="${actionId}">`}
<input type="hidden" name="scope" value="all">
<input type="hidden" name="confirm" value="${RESET_CONFIRM_WORD}">
<p class="ch-meta">${ARCHIVE_NOTE}</p>
<p class="ch-meta">${ASYNC_NOTE}</p>`;
  const previewForm = postForm({
    action: rebuildPreviewPath(),
    csrf: context.csrf,
    fields: previewFields,
    submit: '预检归档并初始化',
    danger: true,
  });
  const executeForm =
    actionId === undefined || !context.plan || context.plan.blocked.length
      ? html``
      : postForm({
          action: rebuildExecutePath(),
          csrf: context.csrf,
          fields: html`<input type="hidden" name="actionId" value="${actionId}">`,
          submit: '确认执行',
          danger: true,
        });
  const newAction =
    actionId === undefined
      ? html``
      : postForm({
          action: rebuildNewActionPath(),
          csrf: context.csrf,
          fields: html``,
          actions: submitButton('重新选择', { secondary: true }),
        });
  const restoreHint = html`<p>若你已有一份部署定义文件（账户、团队、分配、业务系统、执行器和要发布的包），先完成「归档并初始化」，再到运行 Hub 的服务器上执行 ${code('circle-hub apply')}，把定义写回去；凭据仍按名字从密钥库接回。</p>
<p class="ch-meta">定义文件的写法见部署说明；本页不上传文件，避免把明文凭据带进浏览器。</p>`;
  return html`${callout('warn', html`<span>${reason}</span>`)}
${detail ? html`<p class="ch-meta">${detail}</p>` : ''}
${planPanel(context)}
<section class="ch-section"><h2 class="ch-section-label">可选做法</h2>
${card({ title: '归档并初始化' }, html`<p>把当前库改名归档，再建一份空库。完成后按提示做首次设置。</p>${previewForm}${executeForm}${newAction}`)}
${card({ title: '用定义文件恢复' }, restoreHint)}
</section>
<p>${link(overviewPath(), '返回总览')} · ${link(settingsPath() + '?tab=hub#reset-rebuild', '打开设置里的重置和重建')} · ${link(setupPath(), '首次设置')}</p>`;
}

export function rebuildPageBody(context: RebuildConsoleContext): Html {
  return box(
    { title: '需要重建', hint: '这个 Hub 的数据结构和当前程序版本不一致时，只开放本页和健康检查。' },
    context.authorized
      ? authorizedRebuildBody(context)
      : html`${callout('warn', html`<span>${context.rebuildNeeded?.reason ?? '当前数据与本版本对不上，不能继续按平常方式使用。'}</span>`)}
<p>请在运行 Hub 的服务器上签发本机维护码后，在此授权。匿名只能看到本页的授权表单和健康检查里的「需要重建」提示，看不到诊断细节。</p>
${authorizeForm(context.csrf, context.loginNonce)}
<p class="ch-meta">也可在本机执行 ${code('circle-hub reset')}。</p>`,
  );
}

/** Pure rebuild page for the lightweight incompatible-store server; default `ServeOptions.rebuild.render`. */
export function renderRebuildPage(context: RebuildConsoleContext): string {
  return String(
    page(
      {
        title: '需要重建',
        user: null,
        csrf: context.csrf || null,
        hint: PAGE_HINT,
        active: 'settings',
      },
      rebuildPageBody(context),
    ),
  );
}

/** Ordinary console adapter when the Hub is still fully assembled. */
export function needsRebuildPage(ctx: PageContext, needed: RebuildNeeded | null): PageResult {
  const operationId = ctx.url.searchParams.get('operation') ?? undefined;
  const context: RebuildConsoleContext = {
    authorized: Boolean(ctx.admin && ctx.csrf),
    rebuildNeeded: needed,
    csrf: ctx.csrf ?? '',
    actionId: ctx.url.searchParams.get('actionId') ?? undefined,
    ...(operationId
      ? {
          operation: {
            operationId,
            acknowledged: true,
            running: true,
            completed: false,
          },
        }
      : {}),
  };
  return {
    status: 200,
    body: page(
      ctx.chrome('需要重建', {
        active: 'settings',
        hint: PAGE_HINT,
      }),
      rebuildPageBody(context),
    ),
  };
}
