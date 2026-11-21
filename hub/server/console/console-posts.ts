import type { IncomingMessage, ServerResponse } from 'node:http';
import { axisUiLabel, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { Sha256 } from '../../../contracts/src/common.ts';
import { KnowledgeError } from '../../knowledge/api.ts';
import { LimitError, RecordsError, IntegrityError, sha256Hex, withRequestPermissions, withReadScope, type Principal } from '../../records/api.ts';
import { mediaTypeOf, readBody, sendJson, setCommonHeaders } from '../http.ts';
import { mediaTypeFor } from '../upload.ts';
import { action } from './console-actions.ts';
import { ROUTES } from './console-routes.ts';
import { actionNotice } from './feedback.ts';
import { errorLine } from './components.ts';
import { html, link, page } from './html.ts';
import { performPersonalPackAction } from './personal-packs.ts';
import { recoverEditor } from './form-recovery.ts';
import { performMemoryAction } from './memory.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import type { ConsoleSession } from './session.ts';
import { spaceActionFailure, performSpaceAction } from './spaces.ts';
import { UploadError, boundaryOf, parseMultipart } from './upload.ts';
import {
  type ConsoleOptions, ACTION_FORM_LIMIT, sendHtml, redirect, forbidden, sameOrigin, formOf,
} from './console-http.ts';

export async function handleAuthenticatedConsole(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ConsoleOptions,
  ctx: PageContext,
  session: ConsoleSession,
  principal: Principal,
  segments: string[],
  isAction: boolean,
  isKnowledgeAction: boolean,
): Promise<void> {
  let result: PageResult | null;
  try {
    if (segments.join('/') === 'knowledge/download') {
      const sha = url.searchParams.get('sha256') ?? '', artifact = url.searchParams.get('artifact') ?? '';
      const source = Sha256.safeParse(sha).success && Sha256.safeParse(artifact).success ? await options.deps.knowledge.spaces?.source(principal, sha, undefined, 'model', artifact) : null;
      if (!source?.bytes || !(await options.deps.records.artifacts.canRead(principal, source.artifact) || await options.deps.knowledge.spaces!.mayReadSource(principal, sha, undefined, 'model', artifact))) return sendHtml(response, 404, neutralPage(ctx).body);
      if (source.bytes.length !== source.size || sha256Hex(source.bytes) !== sha) throw new IntegrityError('原文完整性暂不可核对');
      setCommonHeaders(response); response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename=\"original\"; filename*=UTF-8''" + encodeURIComponent(source.artifact.body.name || '原文').replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase()), 'content-length': String(source.bytes.length), 'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'", 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(source.bytes); return;
    }
    if (isKnowledgeAction) {
      if (!sameOrigin(request, options.ownOrigins())) { request.resume(); return forbidden(response, '表单只能从本控制台提交'); }
      let values: URLSearchParams | Map<string, string>;
      let upload: { bytes: Buffer; name: string; mediaType: string } | undefined;
      if (mediaTypeOf(request) === 'multipart/form-data') {
        const boundary = boundaryOf(request.headers['content-type']); if (!boundary) { request.resume(); return forbidden(response, '上传请求的格式不正确'); }
        const read = await readBody(request, options.deps.config.limits.maxUploadBytes + ACTION_FORM_LIMIT); if (!read.ok) { if (read.reason === 'aborted') return void response.destroy(); return sendHtml(response, 413, page(ctx.chrome('原文超出大小上限'), html`<p>原文超出上传大小上限</p>`)); }
        const multipart = parseMultipart(read.bytes, boundary); values = multipart.fields; const file = multipart.files.find(file => file.field === 'archive');
        if (file && file.bytes.length > options.deps.config.limits.maxUploadBytes) return sendHtml(response, 413, page(ctx.chrome('原文超出大小上限'), html`<p>原文超出上传大小上限</p>`));
        if (file) upload = { bytes: file.bytes, name: file.filename, mediaType: mediaTypeFor(file.bytes, undefined, file.filename) };
      } else { const parsed = await formOf(request, ACTION_FORM_LIMIT); if (parsed === 'aborted') return void response.destroy(); if (parsed === 'too_large') return sendHtml(response, 413, page(ctx.chrome('表单超出大小上限'), html`<p>表单超出 ${ACTION_FORM_LIMIT} 字节上限</p>`)); if (typeof parsed === 'string') return forbidden(response, '表单格式不正确'); values = parsed; }
      if (values.get('csrf') !== session.csrf) return forbidden(response, '表单已过期或不是本控制台发出的');
      try {
        const personalPack = segments[0] === 'workflows' || segments[0] === 'skills';
        const target = personalPack ? await performPersonalPackAction(ctx, segments[2], values, options.staging, upload) : segments[2].startsWith('memory-') ? await performMemoryAction(ctx, segments[2].slice(7), values) : await performSpaceAction(ctx, segments[2], values, upload);
        if (ctx.feedback) session.notice = ctx.feedback;
        else if (values.get('preview_grant') !== '1' && segments[2] !== 'share-batch' && segments[2] !== 'memory-share') {
          const state = segments[2] === 'sync-mode' || segments[2] === 'sync-resume' || segments[2] === 'sync-confirm-purge' ? await ctx.deps.records.personalSync?.state(ctx.principal) : undefined;
          const done = personalPack ? actionNotice('packs', segments[2], values) : segments[2].startsWith('memory-') ? actionNotice('memory', segments[2].slice(7), values) : actionNotice('knowledge', segments[2], values, upload);
          session.notice = state ? (segments[2] === 'sync-confirm-purge' ? '已确认清除 · ' : '') + axisUiLabel('sync_mode') + '：' + uiLabelOf('sync_mode', state.mode) : done ?? '已保存';
        }
        return request.headers['circle-hub-form'] === 'enhanced' ? sendJson(response, 200, { location: target }, { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }) : redirect(response, target);
      } catch (error) { result = (segments[0] === 'knowledge' ? recoverEditor(ctx, segments[2], values, error) : null) ?? spaceActionFailure(ctx, error); }
    } else if (isAction) {
      result = await action(request, response, options, ctx, session, segments[2]);
      if (result === null) return;
    } else {
      const route = Object.hasOwn(ROUTES, segments[0]) ? ROUTES[segments[0]] : undefined;
      result = route === undefined ? neutralPage(ctx) : await withRequestPermissions(options.deps.records.artifacts, principal, () => withReadScope(() => route(ctx, segments.slice(1), options, session)));
    }
  } catch (error) {
    if (error instanceof KnowledgeError && error.code) { result = spaceActionFailure(ctx, error); }
    else if (error instanceof LimitError && isKnowledgeAction && (segments[0] === 'workflows' || segments[0] === 'skills')) {
      result = { status: 429, body: page(ctx.chrome('发布校验未完成', { active: 'workflows' }), html`${errorLine(error.message)}<p>${link('/console/workflows/-/publish', '返回发布列表')}</p>`) };
    }
    else if (error instanceof UploadError && isKnowledgeAction) { result = { status: 400, body: page(ctx.chrome('原文上传未完成'), html`${errorLine(error.message)}`) }; }
    else if (error instanceof RecordsError && (error.code === null || isKnowledgeAction && error.code === 'CREDENTIAL_IN_UPLOAD') && !(error.name === 'IntegrityError')) {
      result = { status: 400, body: page(ctx.chrome('请求有误'), html`${errorLine(error.message)}`) };
    } else if (error instanceof TypeError) {
      options.log(`控制台请求参数不对（${url.pathname}）：${error.message}`);
      result = { status: 400, body: page(ctx.chrome('请求有误'), html`${errorLine('请求参数不对')}`) };
    } else {
      options.log(`控制台页面出错（${url.pathname}）：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      result = { status: 500, body: page(ctx.chrome('Hub 内部错误'), html`${errorLine('Hub 内部错误，原因已记入服务日志')}`) };
    }
  }
  sendHtml(response, result.status, result.body);
}
