import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../http.ts';
import { errorLine } from './components.ts';
import { html, page } from './html.ts';
import { ACTIONS, isPackStep, runAction, type Form } from './manage.ts';
// Side effect: team and reset ACTIONS register into manage.ACTIONS before HTML /console/admin/do runs.
import './team-actions.ts';
import './reset-actions.ts';
import { UPLOAD_REFERENCE_ACTIONS, type RegisteredActionName } from './command-form.ts';
import { mediaTypeFor } from '../upload.ts';
import { systemForgetPage, systemTrialPage } from './operations.ts';
import { publication } from './pack-display.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import type { ConsoleSession } from './session.ts';
import { runForgetTrial, runTrial } from './trial.ts';
import { UploadError, boundaryOf, parseMultipart } from './upload.ts';
import {
  type ConsoleOptions, ACTION_FORM_LIMIT, sendHtml, forbidden, sameOrigin, formOf, fields,
} from './console-http.ts';

/** One management action: an administrator's session, this console's origin and its CSRF token, then the command. */
export async function action(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, ctx: PageContext, session: ConsoleSession, name: string): Promise<PageResult | null> {
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    forbidden(response, '管理表单只能从本控制台的页面提交');
    return null;
  }
  if (!ctx.admin) {
    request.resume();
    return neutralPage(ctx);
  }
  // The connection trial and its targeted stop reset run in this process, without a command or a saved configuration.
  if (!isPackStep(name) && !Object.hasOwn(ACTIONS, name) && name !== 'system-test' && name !== 'system-test-forget') {
    request.resume();
    return neutralPage(ctx);
  }
  let form: Form;
  let upload: Buffer | undefined;
  let uploadName = 'upload.bin';
  const needsUpload = name === 'pack-stage' || UPLOAD_REFERENCE_ACTIONS.has(name as RegisteredActionName);
  // The check of 发布任务包 and environment registration take an uploaded file; other actions are plain forms.
  if (needsUpload) {
    const boundary = boundaryOf(request.headers['content-type']);
    if (boundary === null) {
      request.resume();
      forbidden(response, '上传请求的格式不对');
      return null;
    }
    const body = await readBody(request, options.deps.config.limits.maxUploadBytes + ACTION_FORM_LIMIT);
    if (!body.ok) {
      if (body.reason === 'aborted') response.destroy();
      else sendHtml(response, 413, page(ctx.chrome(publication(ctx).title, { active: publication(ctx).active }), errorLine(`上传的文件太大（上限 ${options.deps.config.limits.maxUploadBytes} 字节）`)));
      return null;
    }
    let parsed;
    try {
      parsed = parseMultipart(body.bytes, boundary);
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      forbidden(response, error.message);
      return null;
    }
    form = fields((field) => {
      const all = [...parsed.fields.entries()].filter(([key]) => key === field).map(([, value]) => value);
      if (all.length > 1) return all.join('\n');
      return parsed.fields.get(field);
    });
    const file = parsed.files.find((row) => row.field === 'archive');
    upload = file?.bytes;
    uploadName = file?.filename || uploadName;
  } else {
    const parsed = await formOf(request, ACTION_FORM_LIMIT);
    if (parsed === 'aborted') {
      response.destroy();
      return null;
    }
    if (typeof parsed === 'string') {
      forbidden(response, parsed === 'too_large' ? '表单太大' : '管理请求的格式不对');
      return null;
    }
    form = fields((field) => {
      const all = parsed.getAll(field);
      if (all.length > 1) return all.join('\n');
      return parsed.get(field);
    });
  }
  if (form.get('csrf') !== session.csrf) {
    forbidden(response, '表单已过期或不是本控制台发出的，请刷新页面后重试');
    return null;
  }
  if (name === 'system-test') return systemTrialPage(ctx, form, await runTrial(ctx, form));
  if (name === 'system-test-forget') return systemForgetPage(ctx, form, await runForgetTrial(ctx, form));
  if (UPLOAD_REFERENCE_ACTIONS.has(name as RegisteredActionName)) {
    if (upload === undefined || upload.length === 0) {
      return { status: 400, body: page(ctx.chrome(ACTIONS[name]?.title ?? '管理操作', { active: 'connections' }), errorLine('请选择要上传的文件')) };
    }
    try {
      const stored = await options.deps.records.artifacts.ingest({
        bytes: upload,
        mediaType: mediaTypeFor(upload, undefined, uploadName),
        name: uploadName,
        origin: { upload: { session: session.id ?? null, message: null } },
        author: { user: ctx.principal.id },
        provenanceType: 'declared',
        visibility: { readers: [ctx.principal.id], admins: true, packs: [], shareable: false },
      });
      const reference = `src:${stored.body.sha256}`;
      const base = form;
      form = { get: (key) => key === 'reference' ? reference : base.get(key) };
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传原件登记失败';
      return { status: 400, body: page(ctx.chrome(ACTIONS[name]?.title ?? '管理操作', { active: 'connections' }), errorLine(message)) };
    }
  }
  const result = await runAction(ctx, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log }, name, form, session.token, upload);
  if (name === 'password-reset' && result.status === 200) {
    const principals = options.deps.records.principals;
    const user = await principals.get(form.get('user')) ?? await principals.findByName(form.get('user'));
    if (user !== null) options.sessions.clearLoginAttempts(`account:${user.name}`);
  }
  return result;
}
