import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fixture } from './recompose.ts';
const ref = 'src:' + 'a'.repeat(64) + '/json@1/p/text', f = fixture(), base = new URL('../', import.meta.url);
for (const folder of ['authority', 'recompose', 'adjudicate']) {
    const file = JSON.parse(readFileSync(new URL(folder + '/checks.json', base), 'utf8'));
    for (const c of file.checks)
        for (const negative of [false, true]) {
            let subject: any, sources: any = {}, expect: any = { verdict: negative ? 'refute' : 'support', tier: 'blocking' };
            if (folder === 'authority')
                subject = { context: { groups: [{ kind: 'recompose-product@1', authority: negative ? null : f.authority, invalid: negative }] } };
            else if (c.id === 'quotes') {
                subject = { item: 'synthetic', quotes: [{ reference: ref, text: negative ? 'no such quote' : 'synthetic literal' }] };
                sources = { [ref]: 'synthetic literal' };
                if (negative)
                    expect.code = 'QUOTE_MISMATCH';
            }
            else if (folder === 'recompose' && c.id === 'record') {
                subject = structuredClone(f.subject);
                if (negative) {
                    subject.data.contract.expectation.text = '不是原件';
                    expect.code = 'recompose.quote_not_verbatim';
                }
            }
            else if (folder === 'recompose') {
                subject = { items: [{ id: 'synthetic', fields: { source_ref: 'src:' + 'a'.repeat(64), node: 'n/c' }, slots: { record: [{ data: { case: { source_ref: 'src:' + (negative ? 'b' : 'a').repeat(64), node: 'n/c' } } }] } }] };
                if (negative)
                    expect.code = 'recompose.atom_dropped';
            }
            else {
                subject = { location: ref, fields: { atom: 'a1', quote: { reference: ref, text: 'synthetic literal' } }, slots: { decision: [{ code: 'accept', text: '合成裁定', location: ref, quotes: [{ reference: ref, text: 'synthetic literal' }], data: { atom: 'a1', state: 'settled', load_bearing: false, bed_independent: true, reason: negative ? '' : '合成独立判断' } }] } };
                if (negative)
                    expect.code = 'recompose-adjudication.form';
            }
            if (folder === 'authority' && negative)
                expect.code = 'recompose-authority.identity_invalid';
            const dir = new URL(folder + '/samples/' + (negative ? 'negative' : 'positive') + '/', base);
            mkdirSync(dir, { recursive: true });
            writeFileSync(new URL(c.id + '.json', dir), JSON.stringify({ id: c.id + (negative ? '_negative' : '_positive'), source: 'author', check: c.id, subject, ...(Object.keys(sources).length ? { sources } : {}), expect: [expect] }, null, 2) + '\n');
        }
}
