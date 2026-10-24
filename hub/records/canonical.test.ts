// RFC 8785 test vectors and digest vectors. Expected digests were computed with `shasum -a 256` over the expected text.
// Strings with escapes are built from code points at run time so the source holds no ambiguous escape sequences.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, CanonicalizationError } from './canonical.ts';
import { digestOf, envelopeCanonical, envelopeDigest, recordDigest, sha256Hex } from './digest.ts';

const BS = String.fromCharCode(0x5c);
/** JSON text of a \uXXXX escape. */
const esc = (hex: string) => `${BS}u${hex}`;
const ch = (...codes: number[]) => String.fromCharCode(...codes);

// RFC 8785 section 3.2.2 input and section 3.2.4 output.
const RFC_INPUT = [
  '{',
  '  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],',
  `  "string": "${esc('20ac')}$${esc('000F')}${esc('000a')}A'${esc('0042')}${esc('0022')}${esc('005c')}${BS}${BS}${BS}"${BS}/",`,
  '  "literals": [null, true, false]',
  '}',
].join('\n');
const RFC_OUTPUT = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${ch(0x20ac)}$${esc('000f')}${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"}`;
const RFC_OUTPUT_SHA256 = '2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb';

test('RFC 8785 section 3.2.4: canonical output of the section 3.2.2 example', () => {
  const output = canonicalize(JSON.parse(RFC_INPUT));
  assert.equal(output, RFC_OUTPUT);
  assert.equal(Buffer.from(output, 'utf8').toString('hex').slice(-52), 'e282ac245c7530303066' + '5c6e41274' + '25c225c5c5c5c5c222f227d');
  assert.equal(sha256Hex(output), RFC_OUTPUT_SHA256);
  assert.equal(digestOf(JSON.parse(RFC_INPUT)), RFC_OUTPUT_SHA256);
});

test('RFC 8785 section 3.2.3: member names sort by UTF-16 code units', () => {
  const input = JSON.parse(
    [
      '{',
      `"${esc('20ac')}": "Euro Sign",`,
      `"${BS}r": "Carriage Return",`,
      `"${esc('fb33')}": "Hebrew Letter Dalet With Dagesh",`,
      '"1": "One",',
      `"${esc('d83d')}${esc('de00')}": "Emoji: Grinning Face",`,
      `"${esc('0080')}": "Control",`,
      `"${esc('00f6')}": "Latin Small Letter O With Diaeresis"`,
      '}',
    ].join('\n'),
  );
  const expected =
    `{"${BS}r":"Carriage Return","1":"One","${ch(0x80)}":"Control","${ch(0xf6)}":"Latin Small Letter O With Diaeresis",` +
    `"${ch(0x20ac)}":"Euro Sign","${ch(0xd83d, 0xde00)}":"Emoji: Grinning Face","${ch(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`;
  assert.equal(canonicalize(input), expected);
  // Code point order would put U+FB33 before U+1F600; UTF-16 code unit order puts the surrogate pair first.
  assert.ok(expected.indexOf(ch(0xd83d)) < expected.indexOf(ch(0xfb33)));
});

// RFC 8785 appendix B: IEEE 754 bit patterns and their JSON form.
const NUMBERS: Array<[string, string]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

test('RFC 8785 appendix B: number serialization', () => {
  for (const [bits, expected] of NUMBERS) {
    const value = Buffer.from(bits, 'hex').readDoubleBE(0);
    assert.equal(canonicalize(value), expected, bits);
    assert.equal(canonicalize([value]), `[${expected}]`, bits);
  }
  for (const bits of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) {
    assert.throws(() => canonicalize({ n: Buffer.from(bits, 'hex').readDoubleBE(0) }), CanonicalizationError, bits);
  }
});

test('string escapes follow JSON.stringify: short escapes, lowercase \\u00xx, everything else literal', () => {
  const input = `${ch(0x00, 0x1f, 0x08, 0x0c, 0x0a, 0x0d, 0x09)}"${BS}/${ch(0x7f, 0x2028, 0x2029, 0xe9)}`;
  const expected = `"${esc('0000')}${esc('001f')}${BS}b${BS}f${BS}n${BS}r${BS}t${BS}"${BS}${BS}/${ch(0x7f, 0x2028, 0x2029, 0xe9)}"`;
  assert.equal(canonicalize(input), expected);
  assert.equal(canonicalize({ [ch(0)]: 1 }), `{"${esc('0000')}":1}`);
});

test('nested values, null prototypes and omitted undefined members', () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare.b = 1;
  bare.a = [true, null, { d: 'x', c: -0 }];
  assert.equal(canonicalize(bare), '{"a":[true,null,{"c":0,"d":"x"}],"b":1}');
  assert.equal(canonicalize({ keep: 1, drop: undefined }), '{"keep":1}');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize({}), '{}');
  assert.equal(canonicalize({ '10': 1, '2': 2, a: 3, B: 4 }), '{"10":1,"2":2,"B":4,"a":3}');
});

test('values that are not JSON data are refused with the path', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  class Thing {
    x = 1;
  }
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const cases: Array<[unknown, string]> = [
    [{ a: [1, undefined] }, '/a/1'],
    [{ a: sparse }, '/a/1'],
    [{ s: `lone ${ch(0xd800)} surrogate` }, '/s'],
    [{ [ch(0xdc00)]: 1 }, ''],
    [{ big: 1n }, '/big'],
    [{ f: () => 1 }, '/f'],
    [{ s: Symbol('x') }, '/s'],
    [{ d: new Date(0) }, '/d'],
    [{ m: new Map() }, '/m'],
    [{ t: new Thing() }, '/t'],
    [{ b: Buffer.from('x') }, '/b'],
    [cyclic, '/self'],
    [undefined, ''],
    [{ 'a/b~c': { x: NaN } }, '/a~1b~0c/x'],
  ];
  for (const [value, path] of cases) {
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => error instanceof CanonicalizationError && error.path === path,
      path,
    );
  }
  let deep: unknown = 0;
  for (let index = 0; index < 1001; index++) deep = [deep];
  assert.throws(() => canonicalize(deep), CanonicalizationError);
});

test('digest vectors: record envelope digests computed independently', () => {
  const first = { kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: '2026-10-21T08:00:00.000Z', body: { b: [1, 2.5, 'x'], a: { z: null, y: true } } };
  assert.equal(
    canonicalize(first),
    '{"body":{"a":{"y":true,"z":null},"b":[1,2.5,"x"]},"created_at":"2026-10-21T08:00:00.000Z","kind":"claim","provenance":"observed","schema":"claim@1"}',
  );
  assert.equal(recordDigest(first), '3e3e6c8baa77f8d99f3fc0cf72cd353d09c19a3ec1f9c1fd3e9f59ae11d16c4e');
  const second = { kind: 'source_artifact', schema: 'source_artifact@1', provenance: 'declared', created_at: '2026-01-02T03:04:05.006Z', body: { text: '用例标题', n: -0.5 } };
  assert.equal(recordDigest(second), '0d9005a2106fea47549e1c1e1940f344185c7cbe1719553f2400a5c3b422dc90');
  // The fast path the store uses agrees with full canonicalization.
  for (const envelope of [first, second]) {
    const { body, ...meta } = envelope;
    assert.equal(envelopeCanonical(meta, canonicalize(body)), canonicalize(envelope));
    assert.equal(envelopeDigest(meta, canonicalize(body)), recordDigest(envelope));
  }
});

test('streamed bytes and size preserve the predecessor SHA across chunk boundaries, Unicode, escapes and numeric member names', async () => {
  const { canonicalBytes, canonicalByteLength } = await import('./canonical.ts');
  const value = { '2': 'two', '10': 'ten', arr: Array.from({ length: 2500 }, (_, i) => ({ z: '合成😀\u0000' + i, a: [i, -0, 1e30] })) };
  const bytes = canonicalBytes(value);
  assert.equal(sha256Hex(bytes), '0a217a890459db6f9e22b55c509ada276ba998cdb13753c14cc47570a4c44336');
  assert.equal(canonicalByteLength(value), bytes.length);
  assert.equal(Buffer.from(bytes).toString(), canonicalize(value));
  for (const encode of [canonicalBytes, canonicalByteLength]) {
    assert.throws(() => encode({ nested: [undefined] }), (error: unknown) => error instanceof CanonicalizationError && error.path === '/nested/0');
    const cyclic: { self?: unknown ;} = {}; cyclic.self = cyclic; assert.throws(() => encode(cyclic), CanonicalizationError);
  }
});

test('one operation encoder preserves canonical bytes after another mode or a rejected value', async () => {
  const { createCanonicalEncoder, canonicalBytes, canonicalByteLength } = await import('./canonical.ts');
  const encoder = createCanonicalEncoder();
  for (let i = 0; i < 20; i++) {
    const value = { ['field-' + i]: ['合成😀', i, { '10': i, '2': -0 }], drop: undefined };
    assert.equal(encoder.text(value), canonicalize(value));
    assert.deepEqual(encoder.bytes(value), canonicalBytes(value));
    assert.equal(encoder.size(value), canonicalByteLength(value));
    assert.throws(() => encoder.bytes({ bad: Infinity }), CanonicalizationError);
  }
});

test('streamed envelope hashing preserves UTF-8 at surrogate pairs on a chunk boundary', () => {
  const meta = { kind: 'tree_root', schema: 'tree_root-rows@1', provenance: 'projected', created_at: '2026-10-24T00:00:00.000Z' };
  for (const padding of [16380, 16381, 16382, 16383, 16384]) {
    const body = canonicalize({ text: 'a'.repeat(padding) + '😀合成'.repeat(20000) });
    assert.equal(envelopeDigest(meta, body), sha256Hex(envelopeCanonical(meta, body)));
  }
});
