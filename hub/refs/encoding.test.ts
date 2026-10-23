import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParseEncodingError, ParseForbiddenError, htmlParser, textParser, xmlParser } from './api.ts';

function utf16(text: string, big: boolean): Buffer {
  const body = Buffer.from(text, 'utf16le'); if (big) body.swap16();
  return Buffer.concat([Buffer.from(big ? [0xfe, 0xff] : [0xff, 0xfe]), body]);
}
const encodings = [
  ['utf-16le', (text: string) => utf16(text, false), Buffer.from([0xff, 0xfe, 65, 0, 0, 0xd8]), 4],
  ['utf-16be', (text: string) => utf16(text, true), Buffer.from([0xfe, 0xff, 0, 65, 0xd8, 0]), 4],
  ['gb18030', (text: string) => Buffer.concat([Buffer.from(text.slice(0, text.indexOf('中文'))), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(text.slice(text.indexOf('中文') + 2))]), Buffer.from([65, 0x81, 0x30, 0x81]), 1],
  ['gbk', (text: string) => Buffer.concat([Buffer.from(text.slice(0, text.indexOf('中文'))), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(text.slice(text.indexOf('中文') + 2))]), Buffer.from([65, 0x81]), 1],
  ['big5', (text: string) => Buffer.concat([Buffer.from(text.slice(0, text.indexOf('中文'))), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from(text.slice(text.indexOf('中文') + 2))]), Buffer.from([65, 0x81]), 1],
] as const;
for (const [charset, encode, invalid, offset] of encodings) {
  test(`${charset} decodes text and XML with original line and element byte ranges`, () => {
    const bytes = encode('中文\nend'); const document = textParser.parse(bytes, { mediaType: `text/plain;charset=${charset}` });
    assert.equal(document.locate('l/1')?.text, '中文');
    const range = document.locate('l/2')!.byteRange!;
    assert.equal(range[0], charset.startsWith('utf-16') ? 8 : 5);
    assert.equal(htmlParser.parse(encode('<p>中文</p>'), { mediaType: `text/html;charset=${charset}` }).model.blocks[0].text, '中文');
    const source = encode(`<?xml version="1.0" encoding="${charset}"?><r>中文</r>`);
    const xml = xmlParser.parse(source); assert.equal(xml.locate('x/r')?.text, '中文');
    assert.equal(source.subarray(...xml.locate('x/r')!.byteRange!).length, charset.startsWith('utf-16') ? 18 : 11);
  });
  test(`${charset} rejects malformed bytes with the encoding and first sequence offset`, () => {
    assert.throws(() => textParser.parse(invalid, { mediaType: `text/plain;charset=${charset}` }), (error: unknown) => error instanceof ParseEncodingError && error.offset === offset && error.message.toLowerCase().includes(charset));
  });
}
test('BOM determines UTF-16 order and XML refuses contradictory declarations', () => {
  assert.equal(textParser.parse(utf16('中文', true)).locate('l/1')?.text, '中文');
  assert.equal(xmlParser.parse(utf16('<?xml version="1.0" encoding="UTF-16"?><r>中文</r>', false)).locate('x/r')?.text, '中文');
  assert.throws(() => xmlParser.parse(utf16('<?xml version="1.0" encoding="UTF-8"?><r/>', false)), ParseEncodingError);
});
test('entity-free DOCTYPE is accepted while declarations and references never fetch or expand entities', () => {
  for (const declaration of ['<!DOCTYPE r>', '<!DOCTYPE r SYSTEM "synthetic\nexternal">', '<!DOCTYPE r SYSTEM "http://192.0.2.1/never.dtd">', '<!DOCTYPE r [<!-- <!ENTITY fake "unused"> -->]>'])
    assert.equal(xmlParser.parse(Buffer.from(`${declaration}<r>合成</r>`)).locate('x/r')?.text, '合成');
  for (const declaration of ['<!DOCTYPE r [<!ENTITY x "合成">]>', '<!DOCTYPE r [<!ENTITY % x SYSTEM "http://192.0.2.1/never.dtd">%x;]>'])
    assert.throws(() => xmlParser.parse(Buffer.from(`${declaration}<r/>`)), ParseForbiddenError);
});

test('GB18030 supplementary characters, euro single bytes and invalid mapping offsets retain source boundaries', () => {
  const body = Buffer.from([0x95, 0x32, 0x82, 0x36, 10, 0x80]);
  const doc = textParser.parse(body, { mediaType: 'text/plain;charset=gb18030' });
  assert.equal(doc.locate('l/1')?.text, '𠀀'); assert.deepEqual(doc.locate('l/1')?.byteRange, [0, 4]); assert.deepEqual(doc.locate('l/2')?.byteRange, [5, 6]);
  const invalid = Buffer.concat([Buffer.alloc(20000, 65), Buffer.from([0x81])]);
  assert.throws(() => textParser.parse(invalid, { mediaType: 'text/plain;charset=gbk' }), (error: unknown) => error instanceof ParseEncodingError && error.offset === 20000);
});

test('Big5 special pairs keep later line offsets aligned with the platform mapping', () => {
  const source = Buffer.from([0x88, 0x62, 10, 65]);
  const doc = textParser.parse(source, { mediaType: 'text/plain;charset=big5' });
  assert.equal(doc.locate('l/1')?.text, new TextDecoder('big5', { fatal: true }).decode(source.subarray(0, 2)));
  assert.deepEqual(doc.locate('l/2')?.byteRange, [3, 4]);
});

test('platform Big5 single-byte extensions do not displace following line ranges', () => {
  for (const byte of [0x80, 0xff]) {
    const source = Uint8Array.of(byte, 10, 65);
    const doc = textParser.parse(source, { mediaType: 'text/plain;charset=big5' });
    assert.equal(doc.locate('l/1')?.text, new TextDecoder('big5', { fatal: true }).decode(source.subarray(0, 1)));
    assert.deepEqual(doc.locate('l/2')?.byteRange, [2, 3]);
  }
});

test('GBK four-byte sequences retain every decodable prefix boundary and later line ranges', async () => {
  const { decodeEncoding } = await import('./text-decoding.ts');
  for (const body of [Buffer.from([0x81, 0x30, 0x81, 0x30, 10, 65, 66]), Buffer.from([0x95, 0x32, 0x82, 0x36, 0xd6, 0xd0, 10, 65])]) {
    const decoded = decodeEncoding('text@1', body, 'gbk');
    for (let at = 0; at <= body.length; at++) {
      let prefix: string;
      try { prefix = new TextDecoder('gbk', { fatal: true }).decode(body.subarray(0, at)); } catch { continue; }
      assert.equal(decoded.offsets.at(prefix.length), at, `prefix ${at}`);
    }
  }
  const lines = textParser.parse(Buffer.from([0x81, 0x30, 0x81, 0x30, 10, 65, 66]), { mediaType: 'text/plain;charset=gbk' });
  assert.deepEqual(lines.locate('l/1')?.byteRange, [0, 4]); assert.deepEqual(lines.locate('l/2')?.byteRange, [5, 7]);
  for (const prefix of [Buffer.alloc(0), Buffer.alloc(16382, 65)]) {
    const bad = Buffer.concat([prefix, Buffer.from([0x81, 0x30, 0x81, 0x30, 65, 0x81, 0x20])]);
    assert.throws(() => decodeEncoding('text@1', bad, 'gbk'), (error: unknown) => error instanceof ParseEncodingError && error.offset === prefix.length + 5);
  }
});

test('DTD processing instructions cannot hide declarations or create false ENTITY tokens', () => {
  assert.throws(() => xmlParser.parse(Buffer.from(`<!DOCTYPE x [<?pi don't?><!ENTITY a "b">]><x/>`)), ParseForbiddenError);
  assert.equal(xmlParser.parse(Buffer.from('<!DOCTYPE x [<?pi <!ENTITY ?>]><x/>')).model.root.name, 'x');
  assert.equal(xmlParser.parse(Buffer.from(`<!DOCTYPE x [<?pi "'< !ENTITY ?> <!-- <!ENTITY a "b"> -->]><x/>`)).model.root.name, 'x');
});

test('XML refuses uninterpreted internal declarations instead of losing defaulted attributes', () => {
  assert.throws(() => xmlParser.parse(Buffer.from('<!DOCTYPE cmd [<!ATTLIST cmd mode CDATA "disabled">]><cmd name="x"/>')), (error: unknown) => error instanceof ParseForbiddenError && /属性声明/.test(error.message));
  assert.equal(xmlParser.parse(Buffer.from('<!DOCTYPE cmd [<!ELEMENT cmd EMPTY>]><cmd/>')).model.root.name, 'cmd');
});
test('DOCTYPE presence and unread external-subset policy are explicit model structure', () => {
  const doc = xmlParser.parse(Buffer.from('<!DOCTYPE x SYSTEM "http://192.0.2.1/never.dtd" [<!-- synthetic --><?pi synthetic?>]><x/>'));
  assert.deepEqual(doc.model.doctype, { internalSubset: true, externalSubsetDeclared: true, externalSubsetRead: false });
  assert.equal(doc.summary().doctype, true); assert.equal(doc.summary().internalSubset, true);
  assert.equal(xmlParser.parse(Buffer.from('<x/>')).summary().doctype, false);
});

for (const value of [
  '<!DOCTYPE x <!-- [<!ATTLIST x a CDATA "d"> -->]><x/>',
  '<!DOCTYPE x <? [<!ATTLIST x a CDATA "d"> ?>]><x/>',
  '<!DOCTYPE x <!-- [<!ENTITY e "v"> -->]><x/>',
  '<!DOCTYPE x [] <!ATTLIST x a CDATA "d"><x/>',
]) test('malformed DOCTYPE header or trailing text cannot hide declarations: ' + value, () => {
  assert.throws(() => xmlParser.parse(Buffer.from(value)));
});

for (const media of ['text/html', 'application/xhtml+xml']) for (const charset of ['utf-16le', 'utf-16be', 'utf-16']) test(`HTML transport ${media} ${charset} requires a BOM`, () => {
  const bytes = Buffer.from('<p>ab</p><p>cd</p>', 'utf16le');
  assert.throws(() => htmlParser.parse(bytes, { mediaType: `${media};charset=${charset}` }), (e: unknown) => e instanceof ParseEncodingError && e.offset === 0 && /utf-16/.test(e.message));
});
test('HTML meta UTF-16 prescan still uses UTF-8', () => {
  const parsed = htmlParser.parse(Buffer.from('<meta charset="utf-16le"><p>中文</p>'));
  assert.equal(parsed.model.charset, 'utf-8');
});

test('entity-free ELEMENT and NOTATION declarations are retained without fetching external data', () => {
  for (const declaration of ['<!ELEMENT x ANY>', '<!NOTATION n SYSTEM "synthetic>notation">', '<!ELEMENT x EMPTY><!NOTATION n PUBLIC "synthetic" "identifier">']) {
    const doc = xmlParser.parse(Buffer.from(`<!DOCTYPE x [${declaration}]><x/>`));
    assert.equal(doc.model.root.name, 'x'); assert.equal(doc.model.doctype?.internalSubset, true);
    assert.equal(doc.model.doctype?.externalSubsetRead, false);
  }
  assert.throws(() => xmlParser.parse(Buffer.from('<!DOCTYPE x [<!ELEMENT x %part;>]><x/>')), ParseForbiddenError);
  assert.throws(() => xmlParser.parse(Buffer.from('<!DOCTYPE x [<!ATTLIST x a CDATA "d">]><x/>')), (e: unknown) => e instanceof ParseForbiddenError && /显式属性/.test(e.fix));
});

test('derived HTML budgets describe formatting lists and merged attributes rather than raw node counts', () => {
  assert.throws(() => htmlParser.parse(Buffer.from('<p>' + '<b>'.repeat(100) + '<i>x</i>'.repeat(100)), { maxNodes: 500 }), (e: unknown) => e instanceof Error && 'fix' in e && /格式标签.*嵌套|拆分/.test(String(e.fix)) && !/节点\/值数量/.test(String(e.fix)));
  assert.throws(() => htmlParser.parse(Buffer.from('<body a=1 b=2><body c=3 d=4><body e=5 f=6>'), { maxAttributes: 4 }), (e: unknown) => e instanceof Error && /合并|累计/.test(e.message) && 'fix' in e && /合并|累计/.test(String(e.fix)) && /4/.test(String(e.fix)));
});
