import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VariableName, VariableValue, VariableRecord, SecretRecord, VariableUse, SecretUse, OrdinaryVariableUse, VariableDeclaration, referencesIn, resolve, secretLikeName, validateSecret } from './variables.ts';
test('names are exact and reserved prefixes refuse without echo or rewriting', () => {
    assert.equal(VariableName.parse('A'.repeat(64)).length, 64);
    for (const name of ['A'.repeat(65), 'demo', '1DEMO', 'CIRCLE_HUB_X', 'CIRCLE_SERVER_X']) {
        const parsed = VariableName.safeParse(name);
        assert.ok(!parsed.success);
        assert.ok(!parsed.error.message.includes(name));
    }
});
test('secret-like names live in one table and cover process configuration protections', () => {
    for (const name of ['DEMO_PASSWORD', 'DEMO_KEY', 'DEMO_AUTH', 'DEMO_PIN', 'DEMO_API_KEY'])
        assert.ok(secretLikeName(name), name);
    for (const name of ['DEMO_KEYS', 'DEMO_AUTHOR'])
        assert.ok(!secretLikeName(name), name);
    const source = readFileSync(new URL('../../hub/config/index.ts', import.meta.url), 'utf8');
    const words = /const SECRET_LIKE = \/([^/]+)\//.exec(source)![1].split('|');
    for (const word of words)
        assert.ok(secretLikeName('DEMO_' + word), word);
    assert.ok(!VariableRecord.safeParse({ schema: 'variable@1', name: 'DEMO_PASSWORD', value: 'synthetic' }).success);
});
test('references occupy a whole value and preserve JSON pointers', () => {
    assert.deepEqual(referencesIn({ 'a/b': [{ x: '${var:DEMO_X}' }, { x: '${secret:DEMO_KEY}' }] }), [{ at: '/a~1b/0/x', kind: 'var', name: 'DEMO_X' }, { at: '/a~1b/1/x', kind: 'secret', name: 'DEMO_KEY' }]);
    for (const text of ['prefix ${var:DEMO_X}', '${var:DEMO_X}${var:DEMO_Y}', '${var:demo}', '${Var:DEMO_X}', '${var:CIRCLE_HUB_X}'])
        assert.throws(() => referencesIn(text), e => e instanceof Error && !e.message.includes(text));
    for (const text of ['${env:X}', '${HOME:-x}', 'ordinary'])
        assert.deepEqual(referencesIn(text), []);
});
test('replacement is exactly one pass and never interprets inserted values', () => {
    const input = { a: '${var:DEMO_X}', b: ['${var:DEMO_Y}', null] };
    let calls = 0;
    assert.deepEqual(resolve(input, (_kind, name) => { calls++; return name === 'DEMO_X' ? '${var:DEMO_Y}' : { n: 2 }; }), { a: '${var:DEMO_Y}', b: [{ n: 2 }, null] });
    assert.equal(calls, 2);
});
test('ordinary values have exact UTF8 limits and reject nested references controls bindings and non JSON', () => {
    assert.equal(VariableValue.parse('x'.repeat(65534)), 'x'.repeat(65534));
    for (const value of ['x'.repeat(65535), '\0', '\u007f', '\ud800', { x: '${var:DEMO_X}' }, { $value: 'build' }, undefined, Infinity, new Date(), { x: undefined }, { ['bad' + String.fromCharCode(1)]: 1 }, { '${var:DEMO_X}': 1 }])
        assert.ok(!VariableValue.safeParse(value).success);
    assert.ok(VariableValue.safeParse('中文\n\t').success);
    const circular: any = {};
    circular.self = circular;
    assert.ok(!VariableValue.safeParse(circular).success);
});
test('secret text has explicit short admission and never echoes a rejected value', () => {
    assert.equal(validateSecret('reader', true), 'reader');
    assert.equal(validateSecret('SyntheticPassword42'), 'SyntheticPassword42');
    for (const value of ['reader', 'bad\ntext', String.fromCharCode(1) + 'Synthetic', 'x'.repeat(4097)])
        assert.throws(() => validateSecret(value), e => e instanceof Error && !e.message.includes(value));
});
test('secret metadata cannot carry secret material or a digest of its value', () => {
    const record = { schema: 'secret@1', name: 'DEMO_KEY', entry: 'secret.demo_key', digest_rule: 'plain', length: 20, version: 1, set_by: 'usr_' + '0'.repeat(26), set_at: '2026-11-13T07:00:00Z', revoked: false };
    assert.ok(SecretRecord.safeParse(record).success);
    for (const extra of [{ value: 'SyntheticPassword42' }, { sha256: 'b'.repeat(64) }, { consumers: [] }])
        assert.ok(!SecretRecord.safeParse({ ...record, ...extra }).success);
    assert.ok(VariableDeclaration.safeParse({ name: 'DEMO_COMPONENTS', description: 'Synthetic declaration', schema: { type: 'array' }, default: [] }).success);
    assert.ok(!VariableDeclaration.safeParse({ name: 'DEMO_COMPONENTS', description: 'Synthetic declaration', schema: { type: 'array' } }).success);
});


test('vault metadata represents unknown setters without inventing identity or time', () => {
    const metadata = {schema:'secret@1',name:'DEMO_KEY',entry:'secret.demo_key',digest_rule:'plain',length:20,version:2,set_by:null,set_at:null,revoked:false};
    assert.deepEqual(SecretRecord.parse(metadata), metadata);
    assert.equal(SecretRecord.safeParse({...metadata,entry:'secret.other_key'}).success,false);
    assert.equal(SecretRecord.safeParse({...metadata,entry:'secret.demo_key.'+'a'.repeat(24)}).success,false);
    for (const version of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(SecretRecord.safeParse({...metadata,version}).success,false);
    const {set_by,set_at,...missing} = metadata;
    assert.equal(SecretRecord.safeParse(missing).success,false);
});

test('ordinary variable decisions and secret vault versions have distinct evidence identities', () => {
    const ordinary = {kind:'var',at:'res_synthetic#/settings/path',name:'DEMO_PATH',decision:'a'.repeat(64)};
    const secret = {kind:'secret',at:'res_synthetic#/credentials/password',name:'DEMO_KEY',version:2};
    assert.deepEqual(VariableUse.parse(ordinary),ordinary);
    assert.deepEqual(VariableUse.parse(secret),secret);
    assert.deepEqual(OrdinaryVariableUse.parse(ordinary),ordinary);
    assert.deepEqual(SecretUse.parse(secret),secret);
    const {decision,...missingDecision} = ordinary;
    assert.equal(VariableUse.safeParse(missingDecision).success,false);
    for (const extra of [{decision:'a'.repeat(64)},{reference:'rec:'+'a'.repeat(64)},{reference:'src:'+'a'.repeat(64)},{value:'SyntheticPassword42'}]) assert.equal(VariableUse.safeParse({...secret,...extra}).success,false);
    const {version,...missingVersion} = secret;
    assert.equal(VariableUse.safeParse(missingVersion).success,false);
    assert.equal(VariableUse.safeParse({...ordinary,version:2}).success,false);
});
