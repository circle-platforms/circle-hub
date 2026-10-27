import { envelope, reviewSubject } from './recompose-evidence.ts';
export default function (input: any) { const bound = input.inputs?.find((i: any) => i.slot === 'declaration'), submission = envelope(bound, 'submission'), source = envelope(input.inputs?.find((i: any) => i.slot === 'source_run'), 'run'); if (!submission || !source || source.body.run !== submission.body.run || input.context?.predecessor !== submission.body.run)
    return { error: { code: 'SUBMISSION_SCHEMA_VIOLATION', message: '裁定必须以原重组提交的实际运行为只读前驱', fix: '绑定完整 Hub submission rec:，不能上传副本或选无关前驱' }, warnings: [] }; const items = []; for (const [i, row] of submission.body.items.entries()) {
    const r = row.slots?.record?.[0]?.data;
    if (!r)
        continue;
    for (const [a, atom] of (r.atoms ?? []).entries())
        items.push({ id: r.case.id + ':' + atom.id, label: atom.id, location: { slot: 'declaration', parser: 'json@1', selector: `p/body/items/${i}/slots/record/0/data/atoms/${a}` }, fields: { scope: { product: source.body.product, root: source.body.root, product_pack_digest: source.body.product_pack_digest }, atom: atom.id, subject: reviewSubject(r, atom.id), author_run: submission.body.run, quote: { reference: atom.quote_ref, text: atom.text } } });
} return { items, warnings: [] }; }
