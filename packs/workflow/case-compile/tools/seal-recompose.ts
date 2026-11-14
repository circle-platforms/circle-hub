// Client-side lossless assembly only. This never confers Hub admission or chooses a semantic state.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { formatCallError } from '../functions/text.ts';
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const body = (v: any, kind: string) => object(v) && v.kind === kind && object(v.body) ? v.body : v;
export function assembleRecompose(runExport: unknown, parts: unknown[], model: string) {
    const raw = body(runExport, 'run'), run = object(raw) && object(raw.run) ? raw.run : raw;
    if (!object(run) || typeof run.run !== 'string' || !Array.isArray(run.items) || !model)
        throw new Error('缺少完整的原始用例或模型信息');
    const items = new Map<string, any>(run.items.map((i: any) => [i.id, i])), latest = new Map<string, any>();
    for (const part of parts) {
        const submission = body(part, 'submission');
        if (!object(submission) || submission.run !== run.run || !Array.isArray(submission.items))
            throw new Error('重组后的用例不属于本次用例重组');
        for (const row of submission.items) {
            if (!object(row) || !items.has(row.item))
                throw new Error('重组后的用例包含本次用例重组以外的原始用例');
            const claims = row.slots?.record;
            if (!Array.isArray(claims) || claims.length === 0)
                continue;
            if (claims.length !== 1 || !object(claims[0]?.data))
                throw new Error('每条原始用例必须只对应一条重组后的用例');
            const item = items.get(row.item), record = claims[0].data;
            if (record.schema !== 'recompose-record@1' || record.case?.source_ref !== item.fields?.source_ref || record.case?.node !== item.fields?.node || record.case?.id !== item.fields?.case_id)
                throw new Error('重组后的用例与原始用例不对应');
            if (record.predecessor !== undefined && record.predecessor !== run.predecessor)
                throw new Error('重组后的用例与上一次用例重组不对应');
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
        const opts = new Map<string, string>();
        for (let i = 2; i < process.argv.length; i += 2) {
            const key = process.argv[i], value = process.argv[i + 1];
            if (!key?.startsWith('--') || !value || opts.has(key))
                throw new Error('按 README 给出参数');
            opts.set(key, value);
        }
        const get = (key: string) => { const v = opts.get(key); if (!v)
            throw new Error('缺 ' + key); return v; };
        const run = JSON.parse(readFileSync(get('--run'), 'utf8')), parts = JSON.parse(readFileSync(get('--parts'), 'utf8'));
        if (!Array.isArray(parts))
            throw new Error('请使用原始的用例重组结果');
        const result = assembleRecompose(run, parts, get('--model')), bytes = JSON.stringify(result.draft, null, 2) + '\n';
        writeFileSync(get('--out'), bytes, { flag: 'wx' });
        console.log(JSON.stringify({ preview: true, admitted: false, items: result.draft.items.length, missing: result.missing.length, sha256: createHash('sha256').update(bytes).digest('hex'), next_action: result.missing.length ? '用例重组模型继续逐条补齐原始用例' : '把重组后的用例交给 Hub，重新核对全部原始用例' }));
    }
    catch (error) {
        process.stderr.write(formatCallError(error) + '\n');
        process.exitCode = 1;
    }
}
