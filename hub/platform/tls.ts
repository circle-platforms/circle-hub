// The Hub's own HTTPS: a private certificate authority per data root and a server certificate it signs, kept in
// <data root>/tls. Built with node:crypto alone (no openssl, whose LibreSSL and OpenSSL flags differ between macOS and
// Linux): EC P-256 keys, X.509 v3 encoded here in DER and signed with ECDSA-SHA256. The authority's certificate is what
// browsers and Circle (`trust_cert_files`) are told to trust; its key never leaves the directory and is not backed up
// (backups copy objects, vault and config only), so a restored deployment issues a new authority with `tls init`.
import { X509Certificate, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PlatformError } from './errors.ts';
import { writeFileAtomic } from './files.ts';

/** Server certificates stay within what every browser accepts for a private authority (Apple: 825 days, public CAs 398). */
export const SERVER_VALIDITY_DAYS = 397;
export const AUTHORITY_VALIDITY_DAYS = 3650;
/** `tls status` and serve warn this many days before the server certificate ends. */
export const RENEW_WITHIN_DAYS = 30;

export const TLS_FILES = {
  authorityCert: 'ca.crt',
  authorityKey: 'ca.key',
  serverCert: 'server.crt',
  serverKey: 'server.key',
} as const;

export function tlsDirectory(dataDir: string): string {
  return join(dataDir, 'tls');
}

// ---------------------------------------------------------------- DER

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octets = (content: Buffer): Buffer => tlv(0x04, content);
const bits = (content: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content);
const TRUE = tlv(0x01, Buffer.from([0xff]));

/** A non-negative INTEGER from its big-endian magnitude. */
function integer(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  const body = magnitude.subarray(start);
  return tlv(0x02, body[0] & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift(0x80 | (rest & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 on (RFC 5280 4.1.2.5). */
function time(at: Date): Buffer {
  const iso = at.toISOString();
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '');
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extendedKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
} as const;

const ORGANIZATION = 'circle-hub';

function name(commonName: string): Buffer {
  return sequence(
    set(sequence(oid(OID.organization), utf8(ORGANIZATION))),
    set(sequence(oid(OID.commonName), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? sequence(oid(id), TRUE, octets(value)) : sequence(oid(id), octets(value));
}

/** dNSName [2] for names, iPAddress [7] (4 or 16 bytes) for IP literals; brackets of an IPv6 authority are dropped. */
function generalName(host: string): Buffer {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 4) return tlv(0x87, Buffer.from(bare.split('.').map(Number)));
  if (family === 6) return tlv(0x87, ipv6Bytes(bare));
  return tlv(0x82, Buffer.from(bare, 'ascii'));
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, undefined];
  const parse = (part: string | undefined): number[] => (part === undefined || part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16)));
  const front = parse(head);
  const back = parse(tail);
  const groups = tail === undefined ? front : [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(group, index * 2));
  return out;
}

/** The key identifier of a public key: the first 20 bytes of SHA-256 of its SubjectPublicKeyInfo (RFC 7093 method). */
function keyIdentifier(key: KeyObject): Buffer {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest().subarray(0, 20);
}

function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return bytes;
}

interface CertificateInput {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  issuerPublicKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  authority: boolean;
  hosts: readonly string[];
}

function certificate(input: CertificateInput): string {
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const extensions: Buffer[] = input.authority
    ? [
        extension(OID.basicConstraints, true, sequence(TRUE, integer(Buffer.from([0])))),
        // keyCertSign (5) and cRLSign (6): 0b00000110, the last bit unused.
        extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
        extension(OID.subjectKeyIdentifier, false, octets(keyIdentifier(input.subjectKey))),
      ]
    : [
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature (0) only: an ECDSA key does not encipher.
        extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
        extension(OID.extendedKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, sequence(...input.hosts.map(generalName))),
        extension(OID.subjectKeyIdentifier, false, octets(keyIdentifier(input.subjectKey))),
        extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, keyIdentifier(input.issuerPublicKey)))),
      ];
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    algorithm,
    name(input.issuer),
    sequence(time(input.notBefore), time(input.notAfter)),
    name(input.subject),
    input.subjectKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(...extensions)),
  );
  // ECDSA signatures come as the DER Ecdsa-Sig-Value X.509 expects in the BIT STRING.
  const signature = sign('sha256', tbs, input.issuerKey);
  const der = sequence(tbs, algorithm, bits(signature));
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Back-dated a little, so a client whose clock runs slightly behind accepts a certificate issued just now. */
const SKEW_MS = 5 * 60 * 1000;

export interface IssuedPair {
  cert: string;
  key: string;
}

/** A new private certificate authority: EC P-256, valid ten years, path length 0 (it signs server certificates only). */
export function createAuthority(now: Date = new Date(), label = randomBytes(4).toString('hex')): IssuedPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = `circle-hub 本地证书颁发机构 ${label}`;
  const cert = certificate({
    subject,
    issuer: subject,
    subjectKey: publicKey,
    issuerKey: privateKey,
    issuerPublicKey: publicKey,
    notBefore: new Date(now.getTime() - SKEW_MS),
    notAfter: new Date(now.getTime() + AUTHORITY_VALIDITY_DAYS * DAY_MS),
    authority: true,
    hosts: [],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** A server certificate for `hosts` (names and IP literals), signed by `authority`. */
export function issueServerCertificate(authority: IssuedPair, hosts: readonly string[], now: Date = new Date()): IssuedPair {
  const names = serverHosts(hosts);
  const issuerKey = createPrivateKey(authority.key);
  const authorityCert = new X509Certificate(authority.cert);
  if (!authorityCert.checkPrivateKey(issuerKey)) throw new PlatformError('证书颁发机构的证书与私钥不配对', '重新运行 circle-hub tls init --renew-authority');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const notAfter = new Date(Math.min(now.getTime() + SERVER_VALIDITY_DAYS * DAY_MS, new Date(authorityCert.validTo).getTime()));
  const cert = certificate({
    subject: names[0],
    issuer: commonNameOf(authorityCert),
    subjectKey: publicKey,
    issuerKey,
    issuerPublicKey: authorityCert.publicKey,
    notBefore: new Date(now.getTime() - SKEW_MS),
    notAfter,
    authority: false,
    hosts: names,
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

function commonNameOf(cert: X509Certificate): string {
  const match = /(?:^|\n)CN=([^\n]*)/.exec(cert.subject);
  if (match === null) throw new PlatformError('证书颁发机构的证书没有通用名');
  return match[1];
}

/** The names a server certificate covers: the given ones, then localhost and the loopback addresses; no duplicates. */
export function serverHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const host of [...hosts, 'localhost', '127.0.0.1', '::1']) {
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (!out.includes(bare)) out.push(bare);
  }
  return out;
}

// ---------------------------------------------------------------- files

export interface TlsPaths {
  dir: string;
  authorityCert: string;
  authorityKey: string;
  serverCert: string;
  serverKey: string;
}

export function tlsPaths(dataDir: string): TlsPaths {
  const dir = tlsDirectory(dataDir);
  return {
    dir,
    authorityCert: join(dir, TLS_FILES.authorityCert),
    authorityKey: join(dir, TLS_FILES.authorityKey),
    serverCert: join(dir, TLS_FILES.serverCert),
    serverKey: join(dir, TLS_FILES.serverKey),
  };
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Reads one file of the directory: a regular file (never a symlink) of this account, owner-only when it is a key.
 * Null when it does not exist.
 */
async function readPrivate(path: string, key: boolean): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const uid = process.getuid?.();
  if (!info.isFile() || info.nlink !== 1) throw new PlatformError(`${path} 不是普通文件`, '检查 tls 目录，删掉替换上去的链接或特殊文件后重新运行 circle-hub tls init');
  if (uid !== undefined && info.uid !== uid) throw new PlatformError(`${path} 不属于运行 Hub 的账户`, '由 Hub 的账户重新运行 circle-hub tls init');
  if (key && (info.mode & 0o077) !== 0) throw new PlatformError(`${path} 的权限过宽（${(info.mode & 0o777).toString(8)}）`, `chmod 600 ${path}`);
  return readFile(path, 'utf8');
}

async function ensureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new PlatformError(`${dir} 不是目录`);
  await chmod(dir, 0o700);
}

export interface TlsState {
  authority: X509Certificate | null;
  server: X509Certificate | null;
  paths: TlsPaths;
}

export async function readTlsState(dataDir: string): Promise<TlsState> {
  const paths = tlsPaths(dataDir);
  const authority = await readPrivate(paths.authorityCert, false);
  const server = await readPrivate(paths.serverCert, false);
  return { authority: authority === null ? null : new X509Certificate(authority), server: server === null ? null : new X509Certificate(server), paths };
}

export interface TlsInitResult {
  createdAuthority: boolean;
  hosts: string[];
  paths: TlsPaths;
  authorityFingerprint: string;
  serverValidTo: string;
}

/**
 * Issues the server certificate for `hosts`, creating the authority first when there is none (or when `renewAuthority`
 * asks for a new one: every client must then trust the new authority certificate). Keys are written owner-only.
 */
export async function initTls(dataDir: string, hosts: readonly string[], options: { renewAuthority?: boolean; now?: Date } = {}): Promise<TlsInitResult> {
  const paths = tlsPaths(dataDir);
  await ensureDirectory(paths.dir);
  const now = options.now ?? new Date();
  const existingCert = options.renewAuthority ? null : await readPrivate(paths.authorityCert, false);
  const existingKey = options.renewAuthority ? null : await readPrivate(paths.authorityKey, true);
  if ((existingCert === null) !== (existingKey === null)) {
    throw new PlatformError('tls 目录里证书颁发机构的证书和私钥只有一个', '确认没有人动过这个目录后，用 circle-hub tls init --renew-authority 重建证书颁发机构（客户端要重新信任新的证书）');
  }
  let authority: IssuedPair;
  let createdAuthority = false;
  if (existingCert !== null && existingKey !== null) {
    authority = { cert: existingCert, key: existingKey };
    if (new Date(new X509Certificate(existingCert).validTo).getTime() <= now.getTime() + RENEW_WITHIN_DAYS * DAY_MS) {
      throw new PlatformError('证书颁发机构的证书快到期或已到期', '用 circle-hub tls init --renew-authority 重建（客户端要重新信任新的证书）');
    }
  } else {
    authority = createAuthority(now);
    createdAuthority = true;
  }
  const server = issueServerCertificate(authority, hosts, now);
  if (createdAuthority) {
    await writeFileAtomic(paths.authorityKey, authority.key, 0o600);
    await writeFileAtomic(paths.authorityCert, authority.cert, 0o644);
  }
  await writeFileAtomic(paths.serverKey, server.key, 0o600);
  await writeFileAtomic(paths.serverCert, server.cert, 0o644);
  return {
    createdAuthority,
    hosts: serverHosts(hosts),
    paths,
    authorityFingerprint: new X509Certificate(authority.cert).fingerprint256,
    serverValidTo: new X509Certificate(server.cert).validTo,
  };
}

export interface ServerTls {
  cert: string;
  key: string;
  /** The server certificate as parsed, for expiry and names. */
  certificate: X509Certificate;
}

/**
 * The server certificate and key `serve` listens with: both must exist, belong to this account, pair, and still be valid.
 * A certificate within RENEW_WITHIN_DAYS of its end is accepted; the caller warns.
 */
export async function readServerTls(dataDir: string, now: Date = new Date()): Promise<ServerTls> {
  const paths = tlsPaths(dataDir);
  const cert = await readPrivate(paths.serverCert, false);
  const key = await readPrivate(paths.serverKey, true);
  if (cert === null || key === null) throw new PlatformError(`配置了 HTTPS，但 ${paths.dir} 里没有服务器证书或私钥`, '运行 circle-hub tls init 签发证书后再启动');
  const certificate = new X509Certificate(cert);
  if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new PlatformError('服务器证书与私钥不配对', '运行 circle-hub tls issue 重新签发');
  if (new Date(certificate.validTo).getTime() <= now.getTime()) throw new PlatformError(`服务器证书已于 ${certificate.validTo} 到期`, '运行 circle-hub tls issue 重新签发');
  return { cert, key, certificate };
}

/** Days until a certificate ends (negative when it has). */
export function daysLeft(certificate: X509Certificate, now: Date = new Date()): number {
  return Math.floor((new Date(certificate.validTo).getTime() - now.getTime()) / DAY_MS);
}

/** The names a certificate's subjectAltName lists, as `DNS:x` / `IP Address:y` become `x` / `y`. */
export function certificateHosts(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? '').split(/,\s*/).filter(Boolean).map((entry) => entry.replace(/^(?:DNS|IP Address):/, ''));
}
