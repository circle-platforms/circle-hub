import { formatClientCallError } from '../functions/client-cli.ts';
// Client-side lossless assembly only. This never confers Hub admission or chooses a semantic state.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CallFailure, parseCliOptions } from '../functions/text.ts';
import { resolveRun } from './workspace-path.ts';
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const body = (v: any, kind: string) => object(v) && v.kind === kind && object(v.body) ? v.body : v;
export function assembleRecompose(runExport: unknown, parts: unknown[], model: string) {
    const raw = body(runExport, 'run'), run = object(raw) && object(raw.run) ? raw.run : raw;
    if (!object(run) || typeof run.run !== 'string' || !Array.isArray(run.items) || !model)
        throw new CallFailure("invalid_parameters", '缺少完整的原始用例或模型信息', "提供包含 run 和 items 的完整运行导出，并用 --model 写明本次重组模型");
    const items = new Map<string, any>(run.items.map((i: any) => [i.id, i])), latest = new Map<string, any>();
    for (const part of parts) {
        const submission = body(part, 'submission');
        if (!object(submission) || submission.run !== run.run || !Array.isArray(submission.items))
            throw new CallFailure("invalid_parameters", '重组后的用例不属于本次用例重组', "用 --parts 提供属于 --run 运行的原始提交集合，每条提交须有 items 数组");
        for (const row of submission.items) {
            if (!object(row) || !items.has(row.item))
                throw new CallFailure("invalid_parameters", '重组后的用例包含本次用例重组以外的原始用例', "只保留当前运行 items 中声明的原始用例，其他运行另行组装");
            const claims = row.slots?.record;
            if (!Array.isArray(claims) || claims.length === 0)
                continue;
            if (claims.length !== 1 || !object(claims[0]?.data))
                throw new CallFailure("invalid_parameters", '每条原始用例必须只对应一条重组后的用例', "为该原始用例只保留一条 slots.record，且 record.data 必须是对象");
            const item = items.get(row.item), record = claims[0].data;
            if (record.schema !== 'recompose-record@1' || record.case?.source_ref !== item.fields?.source_ref || record.case?.node !== item.fields?.node || record.case?.id !== item.fields?.case_id)
                throw new CallFailure("invalid_parameters", '重组后的用例与原始用例不对应', "按当前运行中该用例的 source_ref、node 和 case_id 恢复原始重组记录");
            if (record.predecessor !== undefined && record.predecessor !== run.predecessor)
                throw new CallFailure("invalid_parameters", '重组后的用例与上一次用例重组不对应', "使用当前运行 predecessor 对应的重组记录，勿混入其他前驱的结果");
            const copy = structuredClone(claims[0]);
            if (run.predecessor !== undefined)
                copy.data.predecessor = run.predecessor;
            latest.set(row.item, copy);
        }
    }
    const missing = run.items.filter((i: any) => !latest.has(i.id)).map((i: any) => i.id), draft = { run: run.run, model, items: run.items.map((i: any) => ({ item: i.id, handling: 'handled', slots: { record: latest.has(i.id) ? [latest.get(i.id)] : [] } })) };
    return { draft, missing, admitted: false as const };
}
if (import.meta.main) {
    try {
        const opts = parseCliOptions(process.argv.slice(2), { run: true, parts: true, model: true, out: true }, 'seal-recompose.ts --run <运行目录> --parts <提交数组JSON> --model <模型标识> --out <新文件>');
        const readJson = (path: string, argument: string): unknown => {
            const bytes = readFileSync(path);
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
            catch { throw new CallFailure('invalid_parameters', `${argument} 不是完整的 UTF-8 JSON`, '重新导出本次运行对应的完整原始 JSON 文件后重试', { path }); }
        };
        // --run is the run directory (download-run.ts's output), the folder that holds run.json; the parts are a file.
        const run = readJson(resolveRun(opts.run!).file.lexical, '--run'), parts = readJson(opts.parts!, '--parts');
        if (!Array.isArray(parts))
            throw new CallFailure("invalid_parameters", '请使用原始的用例重组结果', "把 --parts 指向保存原始重组提交的 JSON 数组，而非单条计划或运行导出");
        const result = assembleRecompose(run, parts, opts.model!), bytes = JSON.stringify(result.draft, null, 2) + '\n';
        writeFileSync(opts.out!, bytes, { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ preview: true, admitted: false, items: result.draft.items.length, missing: result.missing.length, sha256: createHash('sha256').update(bytes).digest('hex'), next_action: result.missing.length ? '用例重组模型继续逐条补齐原始用例' : '把重组后的用例交给 Hub，重新核对全部原始用例' }));
    }
    catch (error) {
        process.stderr.write(formatClientCallError(error) + '\n');
        process.exitCode = 1;
    }
}
