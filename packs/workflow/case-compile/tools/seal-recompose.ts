// Client-side lossless assembly only. This never confers Hub admission or chooses a semantic state.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const body = (v: any, kind: string) => object(v) && v.kind === kind && object(v.body) ? v.body : v;
export function assembleRecompose(runExport: unknown, parts: unknown[], model: string) {
    const raw = body(runExport, 'run'), run = object(raw) && object(raw.run) ? raw.run : raw;
    if (!object(run) || typeof run.run !== 'string' || !Array.isArray(run.items) || !model)
        throw new Error('缺完整运行导出与客户端模型身份');
    const items = new Map<string, any>(run.items.map((i: any) => [i.id, i])), latest = new Map<string, any>();
    for (const part of parts) {
        const submission = body(part, 'submission');
        if (!object(submission) || submission.run !== run.run || !Array.isArray(submission.items))
            throw new Error('分片不属于该实际运行');
        for (const row of submission.items) {
            if (!object(row) || !items.has(row.item))
                throw new Error('分片含冻结任务集合之外的条目');
            const claims = row.slots?.record;
            if (!Array.isArray(claims) || claims.length === 0)
                continue;
            if (claims.length !== 1 || !object(claims[0]?.data))
                throw new Error('分片缺唯一重组候选');
            const item = items.get(row.item), record = claims[0].data;
            if (record.schema !== 'recompose-record@1' || record.case?.source_ref !== item.fields?.source_ref || record.case?.node !== item.fields?.node || record.case?.id !== item.fields?.case_id)
                throw new Error('分片来源身份不等于冻结条目');
            if (record.predecessor !== undefined && record.predecessor !== run.predecessor)
                throw new Error('分片前驱不等于实际运行前驱');
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
            throw new Error('parts 必须是原始提交记录数组');
        const result = assembleRecompose(run, parts, get('--model')), bytes = JSON.stringify(result.draft, null, 2) + '\n';
        writeFileSync(get('--out'), bytes, { flag: 'wx' });
        console.log(JSON.stringify({ preview: true, admitted: false, items: result.draft.items.length, missing: result.missing.length, sha256: createHash('sha256').update(bytes).digest('hex'), next_action: result.missing.length ? '重组模型继续逐案提交，不封批' : '提交此草稿，由 Hub 对冻结全集与所有要求项重新核验' }));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : '重组草稿汇总未完成');
        process.exitCode = 1;
    }
}
