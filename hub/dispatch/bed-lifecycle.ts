import { sha256Hex, type ActionBody, type Principal } from '../records/api.ts';
import { at, type ExecutorDefinition } from './definition.ts';
import { eventOf, type JobBinding } from './journal.ts';
import { RpcClient, ToolReplyError, object } from './transport.ts';
import { PrecheckFactError } from './precheck-failure.ts';
import { judgeBedSurface } from '../../packs/workflow/test-bed/api.ts';
import { againstBaseline, againstStored, bedLimits, bedName, cleanupSteps, missingProbeFact, parseReply, residueFact, unknownSteps, unrestoredFact, captureText, lineDiff, unregisteredBaselineFact, unregisteredBaselineNext, residueCaptureFact, residueCaptureNext, compareHeldProbes, disjointHoldFact, holdClearNext, unrestoredHoldNext, holdMissingBaselineFact, ignoredHoldProbes, type BedRead, type BedReport, type Canonical, type Difference } from './bed-state.ts';
import type { DispatchService } from './service.ts';

interface BedContext extends Pick<DispatchService, 'options' | 'journal' | 'registry' | 'getBaseline'> {
  latestExecutorHold(executor: string): Promise<{ job: string; bed: string; state: string } | null>;
  frozenValue(binding: JobBinding, d: ExecutorDefinition, pointer: string): Promise<unknown>;
  readBed(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>, when: 'pre' | 'post'): Promise<BedRead[]>;
  noteBed(binding: JobBinding, when: 'pre' | 'post', bed: string, reads: readonly BedRead[], differences: BedReport['differences']): Promise<Record<string, Canonical>>;
  openBedHold(bed: string): Promise<{ job: string; pre: Record<string, Canonical>; pre_reads?: BedRead[] } | null>;
  effectivelyComplete(job: string): Promise<boolean>;
  restoredReport(job: string): Promise<BedReport | null>;
}

export async function frozenValue(this: BedContext, binding: JobBinding, d: ExecutorDefinition, pointer: string): Promise<unknown> {
    if (!d.manifest_sha256) return undefined;
    const owner = await this.options.records.principals.get(binding.user);
    if (!owner || owner.disabled) return undefined;
    let source;
    try { source = await this.options.records.artifacts.source(owner, d.manifest_sha256, { consumer: 'function' }); } catch { return undefined; }
    if (!source?.bytes || sha256Hex(source.bytes) !== d.manifest_sha256) return undefined;
    try { return at(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)), pointer); } catch { return undefined; }
  }

export async function readBed(this: BedContext, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>, when: 'pre' | 'post'): Promise<BedRead[]> {
    const spec = d.bed_state;
    if (!spec) return [];
    const reads: BedRead[] = [];
    for (const item of spec.items) {
      try {
        const response = await client.declaredRead(item.call, context, `bed.${when}.${item.id}`);
        const raw = at(response.value, item.output ?? '/output') ?? at(response.value, '/output');
        const text = typeof raw === 'string' ? captureText(raw, item.lead, item.trail) : undefined;
        let sha256: string | undefined;
        let reference: string | undefined;
        if (text !== undefined) {
          const textBytes = new TextEncoder().encode(text);
          sha256 = sha256Hex(textBytes);
          const artifact = await this.options.records.artifacts.ingest({
            bytes: textBytes,
            mediaType: 'text/plain',
            origin: { upload: { session: `bed-${when}` } },
            author: { user: binding.user },
            provenanceType: 'observed',
            visibility: { readers: [binding.user], admins: true, packs: [], shareable: false },
          });
          reference = `art:${artifact.body.sha256}`;
        }
        const canonical = item.parser ? parseReply(item, response.value) : undefined;
        if (text !== undefined) {
          reads.push({
            id: item.id,
            ok: true,
            text,
            sha256,
            reference,
            canonical: canonical ?? { kind: 'address_table', addresses: [] },
            value: response.value,
            source: response.source,
          });
        } else if (canonical !== null && canonical !== undefined) {
          reads.push({
            id: item.id,
            ok: true,
            canonical,
            value: response.value,
            source: response.source,
          });
        } else {
          reads.push({ id: item.id, ok: false, value: response.value, source: response.source });
        }
      } catch (error) {
        reads.push({ id: item.id, ok: false, source: error instanceof ToolReplyError ? error.source : null });
      }
    }
    return reads;
  }

export async function noteBed(this: BedContext, binding: JobBinding, when: 'pre' | 'post', bed: string, reads: readonly BedRead[], differences: BedReport['differences']): Promise<Record<string, Canonical>> {
    const canonical = Object.fromEntries(reads.flatMap(read => read.ok ? [[read.id, read.canonical] as const] : []));
    const sources = reads.flatMap(read => read.source ? [read.source] : []);
    await this.journal.append(binding, 'bed_snapshot', 'read', 'completed', { when, bed, canonical, differences, sources, reads }, sources);
    return canonical;
  }

export async function openBedHold(this: BedContext, bed: string): Promise<{ job: string; pre: Record<string, Canonical>; pre_reads?: BedRead[] } | null> {
    const rows = await this.options.records.store.findMany<ActionBody>({ kind: 'action', key: 'dispatch.phase', values: ['bed_hold'] });
    const mine = rows.filter(row => row.body.detail.bed === bed).sort((left, right) => left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0);
    const last = mine.at(-1);
    const pre = last?.body.detail.pre;
    if (!last || last.body.detail.state !== 'open' || !pre || typeof pre !== 'object' || Array.isArray(pre) || typeof last.body.detail.job !== 'string') return null;
    return { job: last.body.detail.job, pre: pre as Record<string, Canonical>, pre_reads: last.body.detail.pre_reads as BedRead[] | undefined };
  }

export async function latestExecutorHold(this: BedContext, executor: string): Promise<{ job: string; bed: string; state: string } | null> {
    const rows = await this.options.records.store.findMany<ActionBody>({ kind: 'action', key: 'dispatch.executor', values: [executor] });
    const holds = rows.filter(row => row.body.detail.phase === 'bed_hold' && typeof row.body.detail.bed === 'string' && typeof row.body.detail.job === 'string' && typeof row.body.detail.state === 'string');
    holds.sort((left, right) => left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0);
    const last = holds.at(-1);
    if (!last) return null;
    return { job: String(last.body.detail.job), bed: String(last.body.detail.bed), state: String(last.body.detail.state) };
  }

export async function clearBedHold(this: BedContext, by: Principal, executor: string, reason: string): Promise<{ cleared: false } | { cleared: true; job: string; bed: string }> {
    await this.registry.admin(by);
    if (!reason.trim() || reason.includes('\n') || reason.includes('\r')) throw new Error('结清理由必须是一行非空说明');
    const text = reason.trim();
    const open = await this.latestExecutorHold(executor);
    if (!open || open.state !== 'open') return { cleared: false };
    const binding = await this.journal.binding(open.job);
    await this.journal.append(binding, 'bed_hold', 'validate', 'completed', { bed: open.bed, state: 'clear', method: 'admin', reason: text, cleared_by: by.id, held_job: open.job });
    return { cleared: true, job: open.job, bed: open.bed };
  }

/** Member-readable residue facts exclude device echoes and credential or account identities. */
function unrestoredMember(ids: readonly string[]): { fact: string; next_action: string } {
  return { fact: `测试环境上一次上机验证留下的配置还没有恢复，这次没有发出（来源探针 ${[...new Set(ids)].join('、')}）`, next_action: '由测试环境管理员按已声明的清理流程处理并确认恢复后，原样重交原提交' };
}
export async function gateBed(this: BedContext, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<void> {
    const spec = d.bed_state;
    if (!spec) return;
    const bed = spec.bed ? await this.frozenValue(binding, d, spec.bed) : undefined;
    const name = spec.bed ? bedName(bed) : binding.executor;
    if (spec.bed && !name) throw new PrecheckFactError('冻结清单里没有声明的自动化测试环境对象或自动化测试环境名', '管理员核对床面指针和已发布的自动化测试环境清单，补齐自动化测试环境名后再派发；尚未提交');
    const bedNameOrExecutor = name ?? binding.executor;
    const reads = await this.readBed(binding, d, client, context, 'pre');

    const declaration = await this.frozenValue(binding, d, '/surface');

    // Missing probe check (when not using surface judgment)
    if (declaration === undefined) {
      const missing = reads.filter(read => !read.ok).map(read => read.id);
      if (missing.length) {
        await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
        throw new PrecheckFactError(missingProbeFact(missing), unknownSteps(spec.items, missing));
      }
    }

    // Open bed hold check. Overlapping probes compare held text; probes added since the hold compare a registered baseline.
    const hold = await this.openBedHold(bedNameOrExecutor);
    if (hold) {
      const heldReads = hold.pre_reads?.filter(read => read.ok && 'text' in read && typeof read.text === 'string') ?? [];
      const ignoredNote = (ids: readonly string[]) => ids.length ? ignoredHoldProbes(ids) : '';
      const withNote = (fact: string, ignored: readonly string[]) => [fact, ignoredNote(ignored)].filter(Boolean).join('；');
      if (heldReads.length > 0) {
        const baselines = new Map<string, { text: string; sha256: string }>();
        for (const item of spec.items) {
          if (heldReads.some(read => read.id === item.id)) continue;
          const baseline = await this.getBaseline(binding.executor, item.id);
          if (baseline) baselines.set(item.id, { text: baseline.text, sha256: baseline.sha256 });
        }
        const compared = compareHeldProbes(
          heldReads.flatMap(read => read.ok && 'text' in read && typeof read.text === 'string' ? [{ id: read.id, text: read.text, sha256: 'sha256' in read ? read.sha256 : undefined }] : []),
          spec.items.map(item => {
            const read = reads.find(entry => entry.id === item.id);
            const text = read?.ok && 'text' in read && typeof read.text === 'string' ? read.text : undefined;
            return { id: item.id, text, sha256: read?.ok && 'sha256' in read ? read.sha256 : undefined };
          }),
          baselines,
        );
        if (compared.outcome === 'disjoint') {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
          throw new PrecheckFactError(withNote(disjointHoldFact(hold.job, compared.heldIds, compared.currentIds), compared.ignored), holdClearNext(binding.executor));
        }
        if (compared.outcome === 'unread') {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
          throw new PrecheckFactError(missingProbeFact(compared.unread), unknownSteps(spec.items, compared.unread));
        }
        if (compared.outcome === 'no_baseline') {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, compared.differences);
          throw new PrecheckFactError(withNote(holdMissingBaselineFact(compared.missingBaseline), compared.ignored), unregisteredBaselineNext(binding.executor, compared.missingBaseline), {fact:'本次测试环境尚未登记所需基线',next_action:'联系管理员登记本次环境所需基线，完成后重新核对本次环境'});
        }
        if (compared.outcome === 'unrestored') {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, compared.differences);
          const lines = compared.differences.flatMap(diff => diff.diff_lines ?? []).slice(0, 5).join('；');
          throw new PrecheckFactError(withNote([unrestoredFact(compared.differences), lines].filter(Boolean).join('；'), compared.ignored), unrestoredHoldNext(spec.items, compared.differences.map(diff => diff.item), binding.executor), unrestoredMember(compared.differences.map(diff => diff.item)));
        }
        await this.journal.append(binding, 'bed_hold', 'validate', 'completed', { bed: bedNameOrExecutor, state: 'clear', pre: hold.pre, ...(compared.ignored.length ? { ignored_probes: compared.ignored, note: ignoredHoldProbes(compared.ignored) } : {}) });
      } else {
        const heldIds = Object.keys(hold.pre);
        const currentIds = spec.items.map(item => item.id);
        const currentSet = new Set(currentIds);
        const ignored = heldIds.filter(id => !currentSet.has(id));
        const overlap = spec.items.filter(item => Object.hasOwn(hold.pre, item.id));
        if (overlap.length === 0) {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
          throw new PrecheckFactError(withNote(disjointHoldFact(hold.job, heldIds, currentIds), ignored), holdClearNext(binding.executor));
        }
        const outstanding = againstStored(overlap, hold.pre, reads);
        if (outstanding === null) {
          const unread = overlap.filter(item => !reads.find(read => read.id === item.id)?.ok).map(item => item.id);
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
          throw new PrecheckFactError(missingProbeFact(unread.length ? unread : overlap.map(item => item.id)), unknownSteps(spec.items, unread.length ? unread : overlap.map(item => item.id)));
        }
        const added = spec.items.filter(item => !Object.hasOwn(hold.pre, item.id));
        const missingBaseline: string[] = [];
        for (const item of added) {
          const read = reads.find(entry => entry.id === item.id);
          const text = read?.ok && 'text' in read && typeof read.text === 'string' ? read.text : undefined;
          const baseline = await this.getBaseline(binding.executor, item.id);
          if (!baseline || text === undefined) { missingBaseline.push(item.id); continue; }
          if (text !== baseline.text) outstanding.push({ item: item.id, kind: 'changed', identity: item.id, diff_lines: lineDiff(baseline.text, text), pre_sha256: baseline.sha256, post_sha256: read?.ok && 'sha256' in read ? read.sha256 : undefined });
        }
        if (missingBaseline.length) {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, outstanding);
          throw new PrecheckFactError(withNote(holdMissingBaselineFact(missingBaseline), ignored), unregisteredBaselineNext(binding.executor, missingBaseline), {fact:'本次测试环境尚未登记所需基线',next_action:'联系管理员登记本次环境所需基线，完成后重新核对本次环境'});
        }
        if (outstanding.length) {
          await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, outstanding);
          throw new PrecheckFactError(withNote(unrestoredFact(outstanding), ignored), unrestoredHoldNext(spec.items, outstanding.map(diff => diff.item), binding.executor), unrestoredMember(outstanding.map(diff => diff.item)));
        }
        await this.journal.append(binding, 'bed_hold', 'validate', 'completed', { bed: bedNameOrExecutor, state: 'clear', pre: hold.pre, ...(ignored.length ? { ignored_probes: ignored, note: ignoredHoldProbes(ignored) } : {}) });
      }
    }

    // Baseline residue check
    const itemBaselines = await Promise.all(spec.items.map(async item => ({
      item,
      baseline: await this.getBaseline(binding.executor, item.id),
      read: reads.find(r => r.id === item.id),
    })));

    const anyRegistered = itemBaselines.some(ib => ib.baseline !== null);
    const anyWithoutParser = spec.items.some(item => !item.parser);

    if (anyRegistered || anyWithoutParser) {
      const unregistered = itemBaselines.filter(ib => !ib.baseline).map(ib => ib.item.id);
      if (unregistered.length) {
        await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
        throw new PrecheckFactError(
          unregisteredBaselineFact(unregistered),
          unregisteredBaselineNext(binding.executor, unregistered),
          {fact:'本次测试环境尚未登记所需基线',next_action:'联系管理员登记本次环境所需基线，完成后重新核对本次环境'}
        );
      }

      const captureDiffs: Difference[] = [];
      for (const ib of itemBaselines) {
        const text = ib.read?.ok && 'text' in ib.read && typeof ib.read.text === 'string' ? ib.read.text : undefined;
        if (text === undefined || text !== ib.baseline!.text) {
          const diffLines = text !== undefined ? lineDiff(ib.baseline!.text, text) : ['无法读取当前回显原文'];
          captureDiffs.push({
            item: ib.item.id,
            kind: 'changed',
            identity: ib.item.id,
            diff_lines: diffLines,
            pre_sha256: ib.baseline!.sha256,
            post_sha256: ib.read?.ok && 'sha256' in ib.read ? (ib.read.sha256 as string) : undefined,
          });
        }
      }

      await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, captureDiffs);
      if (captureDiffs.length) {
        throw new PrecheckFactError(
          residueCaptureFact(captureDiffs),
          residueCaptureNext(spec.items, captureDiffs, binding.executor),
          unrestoredMember(captureDiffs.map(diff => diff.item))
        );
      }
      return;
    }

    if (declaration !== undefined) {
      const unread = reads.filter(read => read.value === undefined).map(read => read.id);
      if (unread.length) {
        await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
        throw new PrecheckFactError(missingProbeFact(unread), unknownSteps(spec.items, unread));
      }
      const judged = judgeBedSurface(declaration, bed, reads);
      const residueDiffs = judged.ok ? judged.residues.map(residue => ({ item: residue.probe, kind: 'extra' as const, identity: residue.identity })) : [];
      await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, residueDiffs);
      if (!judged.ok) throw new PrecheckFactError(judged.missing, judged.next);
      if (!judged.residues.length) return;
      const probes = [...new Set(judged.residues.map(residue => residue.probe))].join('、');
      if (judged.automatic && judged.cleanup) {
        await this.journal.append(binding, 'bed_cleanup', 'dispatch', 'completed', { executed: false, authorization: 'required', actions: judged.cleanup });
        const steps = judged.cleanup.map(action => `座位 ${action.seat} 的 ${action.command}（粒度 ${action.granularity}）`).join('、');
        throw new PrecheckFactError(`床面残留可自动清理。来源探针 ${probes}`, `下一步经派发和授权执行清理：${steps}。Hub 不执行这些命令`, unrestoredMember(judged.residues.map(residue => residue.probe)));
      }
      const exit = judged.exits.map(item => `由${item.owner}对${item.object}${item.action}，期限 ${item.deadline}`).join('；');
      throw new PrecheckFactError(`床面残留不可自动清理。来源探针 ${probes}`, exit || '下一步：为该残留类补上出口后再派发', unrestoredMember(judged.residues.map(residue => residue.probe)));
    }
    const diffs = againstBaseline(spec.items, bed, reads);
    if (diffs === null) {
      await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, []);
      throw new PrecheckFactError(missingProbeFact(spec.items.map(item => item.id)), unknownSteps(spec.items, spec.items.map(item => item.id)));
    }
    await this.noteBed(binding, 'pre', bedNameOrExecutor, reads, diffs);
    if (diffs.length) throw new PrecheckFactError(residueFact(diffs), cleanupSteps(spec.items, diffs.map(diff => diff.item)), unrestoredMember(diffs.map(diff => diff.item)));
  }

export async function effectivelyComplete(this: BedContext, job: string): Promise<boolean> {
    const end = eventOf(await this.journal.events(job), 'complete');
    return end?.body.detail.done === true && end.body.detail.outcome === 'effective';
  }

export async function restoredReport(this: BedContext, job: string): Promise<BedReport | null> {
    if (!await this.effectivelyComplete(job)) return null;
    const snap = [...await this.journal.events(job)].reverse().find(event => event.body.detail.phase === 'bed_snapshot' && event.body.detail.when === 'post' && Array.isArray(event.body.detail.differences) && event.body.detail.differences.length === 0 && Array.isArray(event.body.detail.reads) && event.body.detail.reads.length > 0 && event.body.detail.reads.every(read => object(read) && read.ok === true));
    if (!snap) return null;
    return { bed: typeof snap.body.detail.bed === 'string' ? snap.body.detail.bed : '', pre: 'passed', recovery: 'restored', differences: [], originals: { pre: [], post: [] }, limits: [], next_action: null };
  }

export async function finishBed(this: BedContext, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<BedReport | null> {
    if (await this.effectivelyComplete(binding.job)) return this.restoredReport(binding.job);
    const spec = d.bed_state;
    if (!spec) return null;
    const events = await this.journal.events(binding.job);
    const pre = [...events].reverse().find(event => event.body.detail.phase === 'bed_snapshot' && event.body.detail.when === 'pre' && event.body.detail.differences instanceof Array && (event.body.detail.differences as unknown[]).length === 0);
    const stored = pre?.body.detail.canonical;
    const name = typeof pre?.body.detail.bed === 'string' ? pre.body.detail.bed : null;
    const prior = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, Canonical> : null;
    const preReads = pre?.body.detail.reads as BedRead[] | undefined;
    const reads = await this.readBed(binding, d, client, context, 'post');
    const sources = { pre: pre?.body.inputs ?? [], post: reads.flatMap(read => read.source ? [read.source] : []) };
    const missing = !name || reads.some(read => !read.ok);
    let diffs: Difference[] | null = null;
    if (!missing && name) {
      const hasTextCaptures = reads.some(r => r.ok && 'text' in r && typeof r.text === 'string');
      if (hasTextCaptures && preReads) {
        diffs = [];
        for (const item of spec.items) {
          const preRead = preReads.find(r => r.id === item.id);
          const postRead = reads.find(r => r.id === item.id);
          if (!preRead || !preRead.ok || !postRead || !postRead.ok || !('text' in preRead) || !('text' in postRead) || preRead.text === undefined || postRead.text === undefined) {
            diffs = null;
            break;
          }
          if (preRead.text !== postRead.text) {
            const diffLines = lineDiff(preRead.text, postRead.text);
            diffs.push({
              item: item.id,
              kind: 'changed',
              identity: item.id,
              diff_lines: diffLines,
              pre_sha256: preRead.sha256,
              post_sha256: postRead.sha256,
            });
          }
        }
      } else if (prior) {
        diffs = againstStored(spec.items, prior, reads);
      }
    }
    const recovery: BedReport['recovery'] = missing || diffs === null ? 'unknown' : diffs.length ? 'unrestored' : 'restored';
    const differences = diffs ?? [];
    const late = await this.restoredReport(binding.job);
    if (await this.effectivelyComplete(binding.job)) return late;
    if (name) await this.noteBed(binding, 'post', name, reads, differences);
    if (name && recovery !== 'restored') await this.journal.append(binding, 'bed_hold', 'validate', 'completed', { bed: name, state: 'open', reason: recovery, pre: prior, differences, pre_reads: preReads });
    const ids = recovery === 'unknown' ? spec.items.map(item => item.id) : differences.map(diff => diff.item);
    return { bed: name ?? '', pre: 'passed', recovery, differences, originals: sources, limits: bedLimits(recovery), next_action: recovery === 'restored' ? null : recovery === 'unknown' ? unknownSteps(spec.items, ids) : cleanupSteps(spec.items, ids) };
  }

