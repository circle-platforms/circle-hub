// The redactor's values the Hub sent as credentials: found in stored bytes in their encodings and charsets, found in planned
// requests, masked in structures without losing their shape; login-body credentials and short values are not looked for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redactor } from './redact.ts';

const TOKEN = ["tok-7f","3c9a1e","5b2d4c","6a8e0f"].join('');

test('a value the Hub sent is found in an answer as given, URI-encoded, JSON-escaped, Base64 and in UTF-16', () => {
  const r = new Redactor();
  assert.equal(r.echoedIn(Buffer.from(`x ${TOKEN} y`), 'text/plain'), false, 'nothing sent yet');
  r.addSent(TOKEN);
  const odd = 'k+7f3c/9a1e="5b2d"';
  r.addSent(odd);
  for (const body of [`x ${TOKEN} y`, Buffer.from(TOKEN).toString('base64'), `?t=${encodeURIComponent(odd)}`, JSON.stringify({ t: odd })]) {
    assert.equal(r.echoedIn(Buffer.from(body), 'text/plain'), true, body);
  }
  assert.ok(!`?t=${encodeURIComponent(odd)}`.includes(odd) && !JSON.stringify({ t: odd }).includes(odd), 'the encoded forms differ from the value');
  assert.equal(r.echoedIn(Buffer.from(TOKEN, 'utf16le'), 'text/plain'), true, 'UTF-16 without a byte order mark');
  assert.equal(r.echoedIn(Buffer.from(`﻿${TOKEN}`, 'utf16le'), 'text/plain; charset=utf-16le'), true, 'UTF-16 as declared');
  assert.equal(r.echoedIn(Buffer.from('an ordinary answer'), 'text/plain'), false);
  assert.equal(r.carriesSent(['/spec/a.md', `/spec/${TOKEN}.md`]), true);
  assert.equal(r.carriesSent(['/spec/a.md']), false);
});

test('a Basic value counts with its password; the user-id and login-body credentials are masked but not looked for', () => {
  const r = new Redactor();
  r.addSent(`Basic ${Buffer.from('reader:Zq8-Secret-77').toString('base64')}`);
  assert.equal(r.echoedIn(Buffer.from('PHP_AUTH_PW Zq8-Secret-77'), 'text/html'), true);
  assert.equal(r.echoedIn(Buffer.from('the reader of the manual'), 'text/plain'), false, 'an account name may be an ordinary word');
  r.add('Synthetic#Pass42');
  assert.equal(r.echoedIn(Buffer.from('Synthetic#Pass42'), 'text/plain'), false, 'a login-body value is never in a stored request');
  assert.equal(r.text('pw Synthetic#Pass42'), 'pw ***', 'but it is masked in texts');
  const short = new Redactor();
  short.addSent('abc12');
  assert.equal(short.echoedIn(Buffer.from('abc12'), 'text/plain'), false, 'too short to tell from ordinary bytes');
});

test('maskSent keeps the whole structure and masks sent values in strings and keys', () => {
  const r = new Redactor();
  r.addSent(TOKEN);
  const big = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(r.maskSent({ path: `/a/${TOKEN}`, list: [1, TOKEN, null], [TOKEN]: true, big }), { path: '/a/***', list: [1, '***', null], '***': true, big });
});

test('both long Basic components and secret digest forms are protected before a request is sent',async()=>{
 const {createHash}=await import('node:crypto');
 const r=new Redactor(),username='DEMO_User42',password='DEMO!Password42';
 r.addSent('Basic '+Buffer.from(username+':'+password).toString('base64'));
 for(const value of [username,password]) {
  assert.equal(r.echoedIn(Buffer.from(value),'text/plain'),true);
  for(const algorithm of ['sha256','sha512'])assert.equal(r.text(createHash(algorithm).update(value).digest('hex')),'***');
 }
});
