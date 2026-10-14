import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TestContext } from 'node:test';
export async function loopbackTLS(t: TestContext, san = 'IP:127.0.0.1,DNS:localhost') {
    const directory = await mkdtemp(join(tmpdir(), 'circle-hub-tls-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const caFile = join(directory, 'ca.pem'), caKey = join(directory, 'ca.key'), keyFile = join(directory, 'server.key'), certFile = join(directory, 'server.pem'), csrFile = join(directory, 'server.csr'), extensions = join(directory, 'extensions.txt'), configFile = join(directory, 'tls.json');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Circle synthetic test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', caKey, '-out', caFile], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Circle synthetic loopback', '-keyout', keyFile, '-out', csrFile], { stdio: 'ignore' });
    await writeFile(extensions, `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    execFileSync('openssl', ['x509', '-req', '-in', csrFile, '-CA', caFile, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-extfile', extensions, '-out', certFile], { stdio: 'ignore' });
    await writeFile(configFile, JSON.stringify({ certFile, keyFile }), { mode: 0o600 });
    return { configFile, caFile, ca: await readFile(caFile) };
}
// Test clients trust only their generated CA and retain hostname verification.
export async function checkedRequest(url: string, options: {
    headers?: Record<string, string>;
    body?: string | Buffer;
    ca?: Buffer;
} = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
        const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: options.body === undefined ? 'GET' : 'POST', headers: options.headers, ca: options.ca, rejectUnauthorized: true }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('error', reject);
            response.on('end', () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.statusCode ?? 500 })));
        });
        request.setTimeout(10000, () => request.destroy(new Error('Synthetic TLS request timed out')));
        request.on('error', reject);
        request.end(options.body);
    });
}
