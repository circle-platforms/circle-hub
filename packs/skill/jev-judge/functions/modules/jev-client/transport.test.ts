import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { JEV_ENDPOINT, JevTransportError, createHttpsTransport, httpsTransport } from './index.ts';
import type { JevTransportRequest } from './index.ts';
import { MAX_RESPONSE_BYTES, transportTag } from './transport.ts';
import { KEY } from '../../../testing/synthetic.ts';

// The network is replaced by a function that plays the part of node:https request(): the transport under test is the real one.
type Send = NonNullable<NonNullable<Parameters<typeof createHttpsTransport>[0]>['request']>;

class FakeClientRequest extends EventEmitter {
  readonly written: Buffer[] = [];
  destroyed = false;
  onEnd: () => void = () => {};
  end(payload?: Buffer): this {
    if (payload !== undefined) this.written.push(payload);
    this.onEnd();
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

interface FakeReply {
  status: number;
  headers?: IncomingMessage['headers'];
  chunks?: ReadonlyArray<Buffer | string>;
  /** False plays a connection that ended before the whole answer arrived. */
  complete?: boolean;
  /** True keeps the answer open: the chunks come and the end never does. */
  open?: boolean;
  encoding?: BufferEncoding;
}

function fakeResponse(reply: FakeReply): IncomingMessage & Readable {
  const response = new Readable({ read() {} }) as IncomingMessage & Readable;
  Object.assign(response, { statusCode: reply.status, headers: reply.headers ?? {}, complete: reply.complete ?? true });
  if (reply.encoding !== undefined) response.setEncoding(reply.encoding);
  setImmediate(() => {
    for (const chunk of reply.chunks ?? []) response.push(chunk);
    if (reply.open !== true) response.push(null);
  });
  return response;
}

type Scenario = (request: FakeClientRequest, respond: (response: IncomingMessage) => void, options: RequestOptions) => void;

function fakeNetwork(scenario: Scenario): { send: Send; seen: Array<{ options: RequestOptions; request: FakeClientRequest }> } {
  const seen: Array<{ options: RequestOptions; request: FakeClientRequest }> = [];
  const send = ((options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    const request = new FakeClientRequest();
    seen.push({ options, request });
    request.onEnd = () => scenario(request, callback, options);
    return request as unknown as ClientRequest;
  }) as Send;
  return { send, seen };
}

const answering = (reply: FakeReply): Scenario => (_request, respond) => respond(fakeResponse(reply));

const base: JevTransportRequest = {
  url: JEV_ENDPOINT,
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{"state":"步骤"}',
  timeoutMs: 5_000,
};

async function rejection(promise: Promise<unknown>): Promise<JevTransportError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevTransportError, String(error));
    return error;
  }
  return assert.fail('the transport resolved');
}

describe('the transport of production', () => {
  it('posts the body to the fixed address and returns the status, the headers in lower case and the text of the body', async () => {
    const { send, seen } = fakeNetwork(
      answering({ status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1', 'b=2'], 'Retry-After': '3', 'x-missing': undefined }, chunks: ['{"ok":', Buffer.from('true}')] }),
    );
    const reply = await createHttpsTransport({ request: send })(base);
    assert.deepEqual(reply, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=1, b=2', 'retry-after': '3' }, body: '{"ok":true}' });
    assert.equal(seen.length, 1);
    const { options, request } = seen[0]!;
    assert.deepEqual(options, {
      method: 'POST',
      protocol: 'https:',
      hostname: 'api.typesafe.ai',
      port: 443,
      path: '/v1/systemone',
      headers: { ...base.headers, 'Content-Length': String(Buffer.byteLength(base.body, 'utf8')) },
      agent: false,
      rejectUnauthorized: true,
    });
    assert.ok(Buffer.byteLength(base.body, 'utf8') > base.body.length, 'the length is in bytes, not characters');
    assert.deepEqual(request.written, [Buffer.from(base.body, 'utf8')]);
  });

  it('sets exactly one certificate option, rejectUnauthorized: true, and none that changes the trust, the proxy or the redirects', async () => {
    const { send, seen } = fakeNetwork(answering({ status: 200, chunks: ['{}'] }));
    await createHttpsTransport({ request: send })(base);
    const options = seen[0]!.options;
    assert.deepEqual(Object.keys(options).sort(), ['agent', 'headers', 'hostname', 'method', 'path', 'port', 'protocol', 'rejectUnauthorized']);
    assert.strictEqual(options.rejectUnauthorized, true);
    for (const name of ['ca', 'cert', 'key', 'pfx', 'passphrase', 'crl', 'ciphers', 'servername', 'checkServerIdentity', 'secureContext', 'secureProtocol', 'minVersion', 'maxVersion']) {
      assert.equal(Object.hasOwn(options, name), false, name);
    }
  });

  it('refuses any address but the fixed one, without making a connection', async () => {
    const { send, seen } = fakeNetwork(answering({ status: 200, chunks: ['{}'] }));
    const transport = createHttpsTransport({ request: send });
    for (const url of [`${JEV_ENDPOINT}/`, `${JEV_ENDPOINT}?x=1`, 'http://api.typesafe.ai/v1/systemone', 'https://example.invalid/v1/systemone', 'https://api.typesafe.ai/v1/other', '', 'file:///etc/hosts']) {
      const error = await rejection(transport({ ...base, url }));
      assert.equal(error.reason, 'connection');
      assert.equal(error.tag, 'URL_REFUSED');
    }
    assert.equal(seen.length, 0);
  });

  it('returns a redirect as it is and makes no second request', async () => {
    const { send, seen } = fakeNetwork(answering({ status: 302, headers: { location: 'https://example.invalid/elsewhere' }, chunks: [''] }));
    const reply = await createHttpsTransport({ request: send })(base);
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.location, 'https://example.invalid/elsewhere');
    assert.equal(seen.length, 1);
  });

  it('takes an answer that arrives as text and one whose characters are split between chunks', async () => {
    const asText = fakeNetwork(answering({ status: 200, chunks: ['{"a":"步', '骤"}'], encoding: 'utf8' }));
    assert.equal((await createHttpsTransport({ request: asText.send })(base)).body, '{"a":"步骤"}');
    const split = Buffer.from('步', 'utf8');
    const asBytes = fakeNetwork(answering({ status: 200, chunks: [split.subarray(0, 2), split.subarray(2)] }));
    assert.equal((await createHttpsTransport({ request: asBytes.send })(base)).body, '步');
  });

  it('takes an empty answer and an answer of exactly the size limit', async () => {
    const empty = fakeNetwork(answering({ status: 204, chunks: [] }));
    assert.deepEqual(await createHttpsTransport({ request: empty.send })(base), { status: 204, headers: {}, body: '' });
    const full = fakeNetwork(answering({ status: 200, chunks: [Buffer.alloc(MAX_RESPONSE_BYTES, 0x61)] }));
    assert.equal((await createHttpsTransport({ request: full.send })(base)).body.length, MAX_RESPONSE_BYTES);
  });

  it('holds an answer to 8 MiB', () => {
    assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  });

  it('gives up on an answer over the size limit, in one chunk or in several, and drops the connection', async () => {
    for (const chunks of [[Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x61)], [Buffer.alloc(MAX_RESPONSE_BYTES / 2 + 1, 0x61), Buffer.alloc(MAX_RESPONSE_BYTES / 2, 0x61)]]) {
      const response = fakeResponse({ status: 200, chunks });
      const { send, seen } = fakeNetwork((_request, respond) => respond(response));
      const error = await rejection(createHttpsTransport({ request: send })(base));
      assert.equal(error.reason, 'response_too_large');
      assert.equal(seen[0]!.request.destroyed, true);
      assert.equal(response.destroyed, true);
    }
  });

  it('refuses an answer that is not UTF-8', async () => {
    const { send } = fakeNetwork(answering({ status: 200, chunks: [Buffer.from([0x7b, 0xff, 0xfe, 0x7d])] }));
    assert.equal((await rejection(createHttpsTransport({ request: send })(base))).reason, 'response_encoding');
  });

  it('gives up with a timeout when nothing comes within the limit, and drops the connection', async () => {
    const { send, seen } = fakeNetwork(() => {});
    const error = await rejection(createHttpsTransport({ request: send })({ ...base, timeoutMs: 20 }));
    assert.equal(error.reason, 'timeout');
    assert.equal(seen[0]!.request.destroyed, true);
  });

  it('gives up with a timeout when the answer starts and does not end, and drops it', async () => {
    const response = fakeResponse({ status: 200, chunks: ['{"partial":'], open: true });
    const { send } = fakeNetwork((_request, respond) => respond(response));
    const error = await rejection(createHttpsTransport({ request: send })({ ...base, timeoutMs: 40 }));
    assert.equal(error.reason, 'timeout');
    assert.equal(response.destroyed, true);
  });

  it('reports a broken connection with the system code, when the code has the shape of one, and never with a message', async () => {
    const failing = (error: Error): Scenario => (request) => void setImmediate(() => request.emit('error', error));
    const cases: ReadonlyArray<[Error, string]> = [
      [Object.assign(new Error('read ECONNRESET: details ' + KEY), { code: 'ECONNRESET' }), 'ECONNRESET'],
      [Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'ENOTFOUND'],
      [Object.assign(new Error('x'), { code: 'econnreset' }), ''],
      [Object.assign(new Error('x'), { code: 'A' }), ''],
      [Object.assign(new Error('x'), { code: 'A'.repeat(42) }), ''],
      [Object.assign(new Error('x'), { code: 5 }), ''],
      [new Error('socket hang up ' + KEY), ''],
    ];
    for (const [cause, tag] of cases) {
      const { send } = fakeNetwork(failing(cause));
      const error = await rejection(createHttpsTransport({ request: send })(base));
      assert.equal(error.reason, 'connection');
      assert.equal(error.tag, tag);
      assert.ok(!error.message.includes(KEY) && !error.message.includes('socket'), error.message);
    }
  });

  it('reports an answer that fails, is aborted or closes before its end as a broken connection', async () => {
    const scenarios: ReadonlyArray<[string, (response: IncomingMessage & Readable) => void, string]> = [
      ['an error of the answer', (response) => void setImmediate(() => response.emit('error', Object.assign(new Error('x'), { code: 'ECONNRESET' }))), 'ECONNRESET'],
      ['an aborted answer', (response) => void setImmediate(() => response.emit('aborted')), 'ECONNRESET'],
      ['an answer closed early', (response) => void setImmediate(() => response.destroy()), 'ECONNRESET'],
    ];
    for (const [name, interfere, tag] of scenarios) {
      const response = fakeResponse({ status: 200, chunks: ['{"partial":'], open: true, complete: false });
      const { send } = fakeNetwork((_request, respond) => {
        respond(response);
        interfere(response);
      });
      const error = await rejection(createHttpsTransport({ request: send })(base));
      assert.equal(error.reason, 'connection', name);
      assert.equal(error.tag, tag, name);
    }
  });

  it('reports a request function that throws as a broken connection', async () => {
    const send = (() => {
      throw Object.assign(new Error('refused'), { code: 'ERR_INVALID_ARG_TYPE' });
    }) as unknown as Send;
    const error = await rejection(createHttpsTransport({ request: send })(base));
    assert.equal(error.reason, 'connection');
    assert.equal(error.tag, 'ERR_INVALID_ARG_TYPE');
  });

  it('settles once: a failure after the answer changes nothing', async () => {
    const { send, seen } = fakeNetwork(answering({ status: 200, chunks: ['{}'] }));
    const reply = await createHttpsTransport({ request: send })(base);
    assert.equal(reply.status, 200);
    seen[0]!.request.emit('error', new Error('late'));
    assert.equal(seen[0]!.request.destroyed, false);
  });

  it('is what the client uses when no transport is given', () => {
    assert.equal(typeof httpsTransport, 'function');
    assert.equal(httpsTransport.length, 1);
  });
});

describe('JevTransportError', () => {
  it('keeps the reason and the tag, and its message names the reason only', () => {
    const error = new JevTransportError('connection', 'ECONNRESET');
    assert.equal(error.reason, 'connection');
    assert.equal(error.tag, 'ECONNRESET');
    assert.equal(error.message, 'Jev transport: connection');
    assert.equal(new JevTransportError('timeout').tag, '');
    assert.ok(error instanceof Error);
  });

  it('keeps a tag only when it has the shape of a system code, whoever made the error', () => {
    for (const tag of ['ECONNRESET', 'URL_REFUSED', 'E1', 'A'.repeat(41)]) assert.equal(new JevTransportError('connection', tag).tag, tag);
    for (const tag of ['', 'econnreset', 'has space', 'A', 'A'.repeat(42), 'STATE-MARKER-4f8a1c', '1ABC', 'ÄÖ_Ü', 'LINE\nBREAK', KEY]) assert.equal(new JevTransportError('connection', tag).tag, '', tag);
  });

  it('turns an error into a tag only when the code has the shape of a system code', () => {
    assert.equal(transportTag({ code: 'ECONNRESET' }), 'ECONNRESET');
    for (const value of [null, undefined, 'ECONNRESET', 5, {}, { code: 5 }, { code: 'lower' }, { code: 'E' }, { code: 'HAS SPACE' }]) assert.equal(transportTag(value), '');
  });
});
