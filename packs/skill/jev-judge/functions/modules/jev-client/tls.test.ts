import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import type { Server, RequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JEV_ENDPOINT, JevTransportError, createHttpsTransport } from './index.ts';
import type { JevTransportRequest } from './index.ts';
import { KEY } from '../../../testing/synthetic.ts';

// A real TLS handshake with a server on the loopback address that presents a self-signed certificate. The production transport is the one
// under test; only the address is changed, by a request function that keeps every other option the transport set.
type Send = NonNullable<NonNullable<Parameters<typeof createHttpsTransport>[0]>['request']>;

const base: JevTransportRequest = {
  url: JEV_ENDPOINT,
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{"state":"a step"}',
  // A ceiling for a hang: a refused handshake ends at once.
  timeoutMs: 20_000,
};

const VARIABLE = 'NODE_TLS_REJECT_UNAUTHORIZED';

describe('the production transport checks the certificate of the server', () => {
  let dir = '';
  let server: Server;
  let port = 0;
  let certificate = '';
  const received: Array<string | undefined> = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-tls-test-'));
    await writeFile(join(dir, 'cert.conf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=synthetic\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-config', join(dir, 'cert.conf'), '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.pem')],
      { stdio: 'ignore' },
    );
    certificate = await readFile(join(dir, 'server.pem'), 'utf8');
    server = createServer({ key: await readFile(join(dir, 'server.key'), 'utf8'), cert: certificate }, (request, response) => {
      received.push(request.headers.authorization);
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** The transport's own request function, pointed at the local server; the change may add or take away options. */
  const toLocal = (change: (options: Record<string, unknown>) => void = () => {}): Send =>
    ((options: RequestOptions, callback: Parameters<Send>[1]) => {
      const local: Record<string, unknown> = { ...options, hostname: '127.0.0.1', port };
      change(local);
      return httpsRequest(local as RequestOptions, callback);
    }) as Send;

  const refused = async (promise: Promise<unknown>): Promise<JevTransportError> => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof JevTransportError, String(error));
      return error;
    }
    return assert.fail('the transport got an answer from a server it must not trust');
  };

  /** Runs the body with the variable set to the given value (or removed), and puts back what was there. */
  const withVariable = async (value: string | undefined, body: () => Promise<void>): Promise<void> => {
    const earlier = process.env[VARIABLE];
    if (value === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = value;
    try {
      await body();
    } finally {
      if (earlier === undefined) delete process.env[VARIABLE];
      else process.env[VARIABLE] = earlier;
    }
  };

  it('delivers the request, with its header, to a server whose certificate it was told to trust (the control of the tests below)', { timeout: 60_000 }, async () => {
    received.length = 0;
    const reply = await createHttpsTransport({ request: toLocal((options) => void (options.ca = certificate)) })(base);
    assert.equal(reply.status, 200);
    assert.deepEqual(received, [`Bearer ${KEY}`]);
  });

  it('refuses a server with a self-signed certificate as a connection failure, and sends it no header', { timeout: 60_000 }, async () => {
    received.length = 0;
    await withVariable(undefined, async () => {
      const error = await refused(createHttpsTransport({ request: toLocal() })(base));
      assert.equal(error.reason, 'connection');
      assert.match(error.tag, /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/u);
    });
    assert.deepEqual(received, []);
  });

  it('refuses it also when the environment says NODE_TLS_REJECT_UNAUTHORIZED=0, which lets a request without the explicit option through', { timeout: 60_000 }, async () => {
    received.length = 0;
    await withVariable('0', async () => {
      // The control: without the explicit option the variable is what decides, and the server gets the request.
      const loose = await createHttpsTransport({ request: toLocal((options) => void delete options.rejectUnauthorized) })(base);
      assert.equal(loose.status, 200, 'the variable is in force in this process, so this test can tell the option from its absence');
      assert.deepEqual(received, [`Bearer ${KEY}`]);
      received.length = 0;

      const error = await refused(createHttpsTransport({ request: toLocal() })(base));
      assert.equal(error.reason, 'connection');
      assert.match(error.tag, /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/u);
    });
    assert.deepEqual(received, [], 'the server received nothing from the real transport');
    assert.equal(process.env[VARIABLE] === '0', false, 'the variable is put back as it was');
  });
});
