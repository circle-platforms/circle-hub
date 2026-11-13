// Vault (adapted from the earlier private vault): AES-256-GCM sealed entries under <data>/vault. The entry name is bound as
// associated data, so a renamed or copied entry does not open; replaces are atomic; the key comes only from a KeyProvider and
// is never created implicitly. A key-check file tells a wrong key apart from an altered entry.
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KeyProvider, Vault, VaultVerification, VaultSecretMetadata, VaultSecretMaterial, VaultSecretWrite } from './api.ts';
import { VariableName, SecretRecord, SecretSidecar, SecretMetadataFile } from '../../contracts/src/variables.ts';
import { isDigestRule } from '../../contracts/generated/vocabulary.ts';
import { VaultError, VaultReadinessError, type VaultReadinessIssue, isVaultReadBoundaryError, unexpectedVaultReadError } from './errors.ts';

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SUFFIX = '.sealed';
const KEY_CHECK = 'key-check';
const FORMAT = 1;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SEALED_BYTES = 128 * 1024;
/** AES-256-GCM with a 96-bit IV and the full 128-bit tag; anything shorter is refused, never accepted as a weaker tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Shows that a secret is set and how long it is, never any of its characters. */
export function maskedForDisplay(value: string | Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return '未设置';
  const length = typeof value === 'string' ? [...value].length : value.byteLength;
  return length === 0 ? '已设置（空值）' : `已设置（长度 ${length}）`;
}

/** Key in a 0600 file. For tests and development; the deployed Hub uses the platform's key file provider (hubKeyProvider). */
export class FileKeyProvider implements KeyProvider {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async getKey(): Promise<Uint8Array> {
    let key: Buffer;
    try {
      key = await readFile(this.path);
    } catch (error) {
      if (errno(error) === 'ENOENT') throw new VaultError('密钥库主密钥不存在；密钥只在显式初始化时创建');
      throw error;
    }
    if (key.byteLength !== 32) throw new VaultError('密钥库主密钥长度不对（应为 32 字节）');
    return new Uint8Array(key);
  }

  async initKey(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.path, 'wx', 0o600);
    } catch (error) {
      if (errno(error) === 'EEXIST') throw new VaultError('密钥库主密钥已经存在，不会替换');
      throw error;
    }
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

interface Sealed {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

const SECRET_QUEUES = new Map<string, Promise<unknown>>();

export class FileVault implements Vault {
  readonly directory: string;
  readonly #provider: KeyProvider | undefined;

  constructor(directory: string, provider?: KeyProvider) {
    this.directory = directory;
    this.#provider = provider;
  }

  #secretEntry(name: string): string {
    if (!VariableName.safeParse(name).success) throw new VaultError('密钥名字不合规则');
    return 'secret.' + name.toLowerCase();
  }
  #metadataVault(): FileVault { return new FileVault(join(this.directory, 'metadata'), this.#provider); }

  #metadataFailure(name: string, entry: string, missing: readonly string[], reason: string): VaultReadinessError {
    return new VaultReadinessError([{ name, entry, missing, reason, next_action: `缺少可信元数据会阻断完整脱敏；请联系数据所有者或从旧备份恢复原设置事实，恢复 vault/metadata/${this.#secretEntry(name)}.sealed 后重试；完全无依据时不要猜版本、重设同名或新建主密钥` }]);
  }

  async #metadataFile(name: string): Promise<SecretMetadataFile | null> {
    const entry = this.#secretEntry(name), metadata = this.#metadataVault();
    let present: boolean;
    try { present = await metadata.has(entry); }
    catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw this.#metadataFailure(name, 'metadata/' + entry + '.sealed', ['metadata'], '认证元数据文件无法访问；请核对目录和读取权限'); }
    if (!present) {
      let values: string[];
      try { values = (await this.list()).filter(candidate => candidate.startsWith(entry + '.') && /^[a-f0-9]{24}$/.test(candidate.slice(entry.length + 1))); }
      catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw this.#metadataFailure(name, entry, ['inventory'], '无法列出该名字的封存条目'); }
      if (values.length) throw new VaultReadinessError(values.map(value => ({ name, entry: value + '.sealed', missing: ['metadata', 'version', 'current', 'digest_rule', 'set_by', 'set_at'], reason: '封存缺少认证元数据；不能从文件时间推断版本或原设置事实', next_action: `请联系数据所有者或从旧备份恢复可信原设置事实，再恢复 vault/metadata/${entry}.sealed（version/current/digest_rule，原人/时刻确实未知才null）；完全无依据时仍阻断完整脱敏，不猜版本、不用新名set冒充已恢复、不新建主密钥` })));
      return null;
    }
    let text: string | null;
    try { text = await metadata.getText(entry); }
    catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw new VaultReadinessError([{ name, entry: 'metadata/' + entry + '.sealed', missing: ['authentication'], reason: '密钥元数据无法认证；当前主密钥不可用、原件或认证标签不合', next_action: '请管理员运行 circle-hub key status 核对主密钥，并恢复匹配的原主密钥或经过核验的认证元数据备份；不要运行 key init' }]); }
    let input: unknown;
    try { input = text === null ? null : JSON.parse(text); }
    catch (error) { if (!(error instanceof SyntaxError)) throw unexpectedVaultReadError(); throw this.#metadataFailure(name, 'metadata/' + entry + '.sealed', ['metadata'], '认证内容不是可解析的元数据JSON；没有使用其中任何值'); }
    const parsed = SecretMetadataFile.safeParse(input);
    if (!parsed.success) {
      const allowed = new Set([...Object.keys(SecretMetadataFile.shape), ...Object.keys(SecretSidecar.shape), ...Object.keys(SecretRecord.shape)]);
      const fields = new Set(parsed.error.issues.flatMap(issue => issue.path.filter((part): part is string => typeof part === 'string' && allowed.has(part)).slice(-1)));
      const versions = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as { versions?: unknown }).versions : undefined;
      if (Array.isArray(versions)) {
        const rows = versions.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row));
        if (rows.length !== versions.length || rows.filter(row => row.current === true).length !== 1 || rows.at(-1)?.current !== true) fields.add('current');
        let previous = 0;
        for (const row of rows) {
          const m = row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : null;
          if (!m) { fields.add('metadata'); continue; }
          if (!Number.isSafeInteger(m.version) || (m.version as number) <= previous) fields.add('version');
          if (typeof m.version === 'number') previous = m.version;
          if (!isDigestRule(m.digest_rule)) fields.add('digest_rule');
        }
      } else { fields.add('versions'); fields.add('current'); }
      if (!fields.size) fields.add('metadata');
      throw this.#metadataFailure(name, 'metadata/' + entry + '.sealed', [...fields], `认证元数据字段缺失或不符合规则：${[...fields].join('、')}`);
    }
    if (parsed.data.name !== name) throw this.#metadataFailure(name, 'metadata/' + entry + '.sealed', ['name'], '认证元数据中的名字与请求名字不一致');
    return parsed.data;
  }

  async #writeMetadata(input: SecretMetadataFile): Promise<void> {
    const parsed = SecretMetadataFile.safeParse(input);
    if (!parsed.success) throw new VaultError('密钥元数据缺少可核对的名字、版本、当前标记或密文身份');
    await this.#key();
    for (const row of parsed.data.versions) if (row.sealed_sha256 !== null) {
      try {
        const original = await readVerifiedFile(this.#path(row.sealed_entry), MAX_SEALED_BYTES);
        if (createHash('sha256').update(original.bytes).digest('hex') !== row.sealed_sha256) throw new Error();
      } catch { throw new VaultError('原封存密文不存在或与提供的身份不符；未写入元数据'); }
    }
    try { await this.#metadataVault().put(this.#secretEntry(parsed.data.name), JSON.stringify(parsed.data)); }
    catch { throw new VaultError('认证元数据写入未完成；请核对主密钥、目录和容量'); }
  }

  /** Authenticates sourced non-value facts without modifying original value ciphertext or assigning a new setter. */
  async writeSecretMetadata(input: SecretMetadataFile): Promise<void> {
    const parsed = SecretMetadataFile.safeParse(input);
    if (!parsed.success) throw new VaultError('密钥元数据缺少可核对的名字、版本、当前标记或密文身份');
    await this.#changeSecret(parsed.data.name, () => this.#writeMetadata(parsed.data));
  }

  async #sidecarValue(row: SecretSidecar): Promise<string | undefined> {
    if (row.sealed_sha256 === null || row.metadata.revoked) return undefined;
    const name = row.metadata.name, entry = row.sealed_entry + '.sealed';
    const fail = (missing: readonly string[], reason: string, next_action: string) => new VaultReadinessError([{ name, entry, missing, reason, next_action }]);
    let original: Awaited<ReturnType<typeof readVerifiedFile>>;
    try { original = await readVerifiedFile(this.#path(row.sealed_entry), MAX_SEALED_BYTES); }
    catch (error) {
      if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError();
      if (errno(error) === 'ENOENT') throw fail(['cipher'], '引用的原封存文件不存在；没有取值', '请管理员从校验过的备份恢复该原sealed文件；保留原文件名和字节，再重试');
      throw fail(['cipher'], '原封存文件无法安全读取；没有取值', '请管理员核对该sealed文件的类型、属主和读取权限，或恢复校验过的原件后重试');
    }
    if (createHash('sha256').update(original.bytes).digest('hex') !== row.sealed_sha256) throw fail(['sealed_sha256'], '原封存密文字节与认证身份不符；没有取值', '请管理员恢复与认证元数据中cipher身份一致的原sealed文件；不要重新计算摘要掩盖原件变化');
    let key: Buffer;
    try { key = await this.#key(); }
    catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw fail(['authentication'], '当前主密钥不可用或与密钥库不符；没有取值', '请管理员运行 circle-hub key status 核对并恢复本数据根对应的原主密钥；不要运行 key init'); }
    let plain: Uint8Array;
    try { plain = openSealed(row.sealed_entry, original.bytes.toString('utf8'), key); }
    catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw fail(['authentication'], '原封存认证失败；主密钥或原件不匹配；没有取值', '请管理员核对原主密钥和原sealed文件来自同一备份，并恢复核验过的原件'); }
    try {
      let value: string;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(plain); }
      catch (error) { if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw fail(['cipher'], '原封存不是有效UTF-8凭据文本；没有取值', '请管理员核对该条目是否确为命名密钥；不要把登录状态或脱敏字典作为密钥导入'); }
      if ([...value].length !== row.metadata.length) throw fail(['length'], '封存值字符长度与认证元数据不等；没有取值', '请管理员根据原设置记录核对length并恢复相匹配的原sealed文件或认证元数据，不推断或输出值');
      return value;
    } finally { plain.fill(0); }
  }

  async #changeSecret<T>(name: string, change: () => Promise<T>): Promise<T> {
    const entry = this.#secretEntry(name), identity = this.directory + '/' + entry;
    const before = SECRET_QUEUES.get(identity) ?? Promise.resolve();
    const pending = before.catch(() => {}).then(async () => {
      const locks = this.directory + '.locks';
      await mkdir(locks, { recursive: true, mode: 0o700 });
      let lock;
      try { lock = await open(join(locks, entry), 'wx', 0o600); }
      catch { throw new VaultError('该名字的密钥正在修改，或上次操作未结束；请管理员核对后重试'); }
      try { return await change(); }
      finally { await lock.close(); await unlink(join(locks, entry)); }
    });
    SECRET_QUEUES.set(identity, pending);
    try { return await pending; }
    finally { if (SECRET_QUEUES.get(identity) === pending) SECRET_QUEUES.delete(identity); }
  }

  async secretNames(): Promise<string[]> {
    const names = (await this.list()).flatMap(entry => {
      const match = /^secret\.([a-z][a-z0-9_]{0,63})\.[a-f0-9]{24}$/.exec(entry);
      return match ? [match[1].toUpperCase()] : [];
    });
    for (const entry of await this.#metadataVault().list()) {
      const match = /^secret\.([a-z][a-z0-9_]{0,63})$/.exec(entry);
      if (!match) throw new VaultReadinessError([{ name: null, entry: 'metadata/', missing: ['namespace'], reason: '密钥元数据目录中有不属于正式命名空间的条目', next_action: '请管理员核对metadata目录；仅接受secret.<逻辑名小写>.sealed，登录状态、脱敏字典与key-check按各自命名空间原样保留' }]);
      names.push(match[1].toUpperCase());
    }
    return [...new Set(names)].sort();
  }

  async secretMetadata(name: string): Promise<VaultSecretMetadata | null> {
    return (await this.#metadataFile(name))?.versions.at(-1)?.metadata ?? null;
  }

  async secretHistory(name: string): Promise<VaultSecretMetadata[]> {
    return (await this.#metadataFile(name))?.versions.map(row => row.metadata).reverse() ?? [];
  }

  async readSecret(name: string): Promise<VaultSecretMaterial | null> {
    const current = (await this.#metadataFile(name))?.versions.at(-1);
    if (!current || current.metadata.revoked) return null;
    const value = await this.#sidecarValue(current);
    if (value === undefined) throw new VaultError('当前版本缺少封存值；没有取值');
    return { name, version: current.metadata.version, metadata: current.metadata, value };
  }

  async recentSecrets(): Promise<VaultSecretMaterial[]> {
    const out: VaultSecretMaterial[] = [], issues: VaultReadinessIssue[] = [];
    let names: string[];
    try { names = await this.secretNames(); }
    catch (error) {
      if (error instanceof VaultReadinessError) throw error;
      if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError();
      throw new VaultReadinessError([{ name: null, entry: 'vault/', missing: ['inventory'], reason: '无法列出密钥库的正式命名条目', next_action: '请管理员核对vault与metadata目录的属主和读取权限，再重试；不要改动或解释其他命名空间的opaque状态文件' }]);
    }
    for (const name of names) {
      try {
        const state = await this.#metadataFile(name);
        if (state?.versions.at(-1)?.metadata.revoked) continue;
        for (const row of (state?.versions ?? []).filter(row => row.sealed_sha256 !== null).slice(-2)) {
          try {
            const value = await this.#sidecarValue(row);
            if (value !== undefined) out.push({ name, version: row.metadata.version, metadata: row.metadata, value });
          } catch (error) {
            if (error instanceof VaultReadinessError) issues.push(...error.issues);
            else throw error;
          }
        }
      } catch (error) {
        if (error instanceof VaultReadinessError) issues.push(...error.issues);
        else if (isVaultReadBoundaryError(error)) issues.push({ name, entry: this.#secretEntry(name), missing: ['metadata'], reason: '该名字的认证元数据未能核对', next_action: '请管理员依据原设置事实恢复该名字的认证元数据，并核对目录读取权限；不会从旧数据库或文件时间补造事实' });
        else throw unexpectedVaultReadError();
      }
    }
    if (issues.length) throw new VaultReadinessError(issues);
    return out;
  }

  async putSecret(input: VaultSecretWrite): Promise<VaultSecretMetadata> {
    const logical = this.#secretEntry(input.name);
    if (!isDigestRule(input.digest_rule) || typeof input.value !== 'string' || !input.value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(input.value) || [...input.value].length < 1 || [...input.value].length > 4096) throw new VaultError('密钥值或摘要规则不合规则');
    return this.#changeSecret(input.name, async () => {
      const previous = await this.#metadataFile(input.name);
      const metadata: VaultSecretMetadata = { schema: 'secret@1', name: input.name, entry: logical, version: (previous?.versions.at(-1)?.metadata.version ?? 0) + 1, digest_rule: input.digest_rule, length: [...input.value].length, set_by: input.set_by, set_at: input.set_at, revoked: false };
      if (!SecretRecord.safeParse(metadata).success || !metadata.set_by || !metadata.set_at) throw new VaultError('设置人的身份或时间不合认证元数据规则');
      const entry = logical + '.' + randomBytes(12).toString('hex');
      try { await this.put(entry, input.value); }
      catch { throw new VaultError('密钥值封存未完成；请核对主密钥、目录和容量'); }
      const cipher = await readVerifiedFile(this.#path(entry), MAX_SEALED_BYTES);
      const rows = (previous?.versions ?? []).map(row => ({ ...row, current: false }));
      rows.push({ metadata, sealed_entry: entry, sealed_sha256: createHash('sha256').update(cipher.bytes).digest('hex'), current: true });
      const retained = rows.filter(row => row.sealed_sha256 !== null && !row.metadata.revoked).slice(-2);
      const removed = rows.filter(row => row.sealed_sha256 !== null && !retained.includes(row));
      for (const row of removed) row.sealed_sha256 = null;
      try { await this.#writeMetadata({ name: input.name, versions: rows }); }
      catch (error) {
        try { await this.remove(entry); }
        catch { throw new VaultError('元数据未发布，新封存值清理未完成；请管理员核对密钥库'); }
        throw error;
      }
      try { for (const row of removed) await this.remove(row.sealed_entry); }
      catch { throw new VaultError('密钥元数据已更新，历史值清理未完成；请管理员核对密钥库'); }
      return metadata;
    });
  }

  async unsetSecret(name: string, by: string, at: string): Promise<VaultSecretMetadata> {
    return this.#changeSecret(name, async () => {
      const state = await this.#metadataFile(name), latest = state?.versions.at(-1);
      if (!state || !latest) throw new VaultError('密钥名字不存在；没有可撤回的封存值');
      if (!by || !Number.isFinite(Date.parse(at))) throw new VaultError('撤回操作者或时刻不合规则');
      const removed = state.versions.filter(row => row.sealed_sha256 !== null).map(row => row.sealed_entry);
      latest.metadata.revoked = true;
      for (const row of state.versions) row.sealed_sha256 = null;
      await this.#writeMetadata(state);
      try { for (const entry of removed) await this.remove(entry); }
      catch { throw new VaultError('密钥已撤回，历史值清理未完成；请管理员核对密钥库'); }
      return latest.metadata;
    });
  }

  async initKey(): Promise<void> {
    if (this.#provider?.initKey === undefined) throw new VaultError('当前的密钥来源不支持初始化密钥');
    await this.#provider.initKey();
  }

  async put(name: string, value: string | Uint8Array): Promise<void> {
    const target = this.#path(name);
    const plain = toBytes(value);
    const key = await this.#key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associatedData(name));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const sealed: Sealed = { v: FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(sealed));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await syncDirectory(this.directory);
  }

  async get(name: string): Promise<Uint8Array | null> {
    const target = this.#path(name);
    const key = await this.#key();
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
    return openSealed(name, text, key);
  }

  async getText(name: string): Promise<string | null> {
    const bytes = await this.get(name);
    return bytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async has(name: string): Promise<boolean> {
    try {
      return (await stat(this.#path(name))).isFile();
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async stat(name: string): Promise<{ written_at: string } | null> {
    try { const info = await stat(this.#path(name)); return info.isFile() ? { written_at: info.mtime.toISOString() } : null; }
    catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (errno(error) === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((file) => file.endsWith(SUFFIX))
      .map((file) => file.slice(0, -SUFFIX.length))
      .filter((name) => NAME.test(name))
      .sort();
  }

  /**
   * Authenticate every entry without writing key-check or revealing names or values. Writers must be stopped while this
   * runs: metadata checks detect changes during the scan, but cannot freeze an unrelated process after the last check.
   */
  async verify(): Promise<VaultVerification> {
    const result: VaultVerification = { checked: 0, failed: 0, unknown: false };
    let key: Buffer | undefined;
    try {
      let before;
      try { before = await lstat(this.directory, { bigint: true }); }
      catch (error) {
        if (errno(error) === 'ENOENT') return { ...result, unknown: true };
        throw error;
      }
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('invalid directory');
      const files = (await readdir(this.directory)).sort();
      const names = files.filter(file => file.endsWith(SUFFIX) && NAME.test(file.slice(0, -SUFFIX.length)));
      result.failed += files.length - names.length - (files.includes(KEY_CHECK) ? 1 : 0) - (files.includes('metadata') ? 1 : 0);
      if (files.includes('metadata')) {
        const nested = await this.#metadataVault().verify();
        result.checked += nested.checked;
        result.failed += nested.failed;
        result.unknown ||= nested.unknown;
      }
      if (this.#provider === undefined) return { ...result, unknown: true };
      try { key = Buffer.from(await this.#provider.getKey()); }
      catch { return { ...result, unknown: true }; }
      if (key.byteLength !== 32) return { ...result, unknown: true };

      const observed = new Map<string, Awaited<ReturnType<typeof fingerprint>>>();
      if (files.includes(KEY_CHECK)) {
        try {
          const entry = await readVerifiedFile(join(this.directory, KEY_CHECK), 1024);
          observed.set(KEY_CHECK, entry.fingerprint);
          const expected = createHmac('sha256', key).update('circle-hub vault key check v1').digest('hex');
          if (entry.bytes.toString('utf8').trim() !== expected) result.failed++;
        } catch { result.failed++; }
      }
      for (const file of names) {
        try {
          const entry = await readVerifiedFile(join(this.directory, file), MAX_SEALED_BYTES);
          observed.set(file, entry.fingerprint);
          const plain = openSealed(file.slice(0, -SUFFIX.length), entry.bytes.toString('utf8'), key);
          plain.fill(0);
          result.checked++;
        } catch { result.failed++; }
      }
      const after = await lstat(this.directory, { bigint: true });
      if (!sameFingerprint(before, after) || JSON.stringify((await readdir(this.directory)).sort()) !== JSON.stringify(files)) result.failed++;
      for (const [file, identity] of observed) {
        try { if (!sameFingerprint(identity, await fingerprint(join(this.directory, file)))) result.failed++; }
        catch { result.failed++; }
      }
      result.unknown ||= result.checked === 0 && result.failed === 0;
      return result;
    } catch {
      // Filesystem errors can contain a path or an entry name: never return the original error.
      return { ...result, failed: result.failed + 1, unknown: true };
    } finally {
      key?.fill(0);
    }
  }

  async remove(name: string): Promise<boolean> {
    try {
      await unlink(this.#path(name));
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
    await syncDirectory(this.directory);
    return true;
  }

  #path(name: string): string {
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('vault entry names are lowercase letters, digits, dot, underscore and dash');
    return join(this.directory, `${name}${SUFFIX}`);
  }

  async #key(): Promise<Buffer> {
    if (this.#provider === undefined) throw new VaultError('没有配置密钥来源，密钥库不可用');
    const key = Buffer.from(await this.#provider.getKey());
    if (key.byteLength !== 32) throw new VaultError('密钥库主密钥长度不对（应为 32 字节）');
    await this.#checkKey(key);
    return key;
  }

  /** Compares an HMAC of a fixed text under the key with the one recorded when the vault was first used. */
  async #checkKey(key: Buffer): Promise<void> {
    const expected = createHmac('sha256', key).update('circle-hub vault key check v1').digest('hex');
    const path = join(this.directory, KEY_CHECK);
    let stored: string | null = null;
    try {
      stored = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    if (stored === null) {
      // Entries but no check file (restored without it): the key must open an existing entry before the check is written,
      // or a second key would silently seal new entries next to the old ones.
      const names = await this.list();
      if (names.length > 0 && !(await this.#opensAnEntry(names, key))) {
        throw new VaultError('密钥与密钥库不符：现有条目没有一条能用这把主密钥解开');
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const handle = await open(path, 'wx', 0o600);
        try {
          await handle.writeFile(`${expected}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
        stored = (await readFile(path, 'utf8')).trim();
      }
    }
    if (stored !== expected) throw new VaultError('密钥与密钥库不符：密钥库是用另一把主密钥封存的');
  }

  /** True when the key opens at least one entry (GCM authentication: a wrong key never opens one). */
  async #opensAnEntry(names: readonly string[], key: Buffer): Promise<boolean> {
    for (const name of names) {
      try {
        openSealed(name, await readFile(this.#path(name), 'utf8'), key);
        return true;
      } catch (error) {
        if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError();
        // An altered entry or another key; try the next one.
      }
    }
    return false;
  }
}

async function fingerprint(path: string) { return lstat(path, { bigint: true }); }

function sameFingerprint(a: Awaited<ReturnType<typeof fingerprint>>, b: Awaited<ReturnType<typeof fingerprint>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function readVerifiedFile(path: string, limit: number): Promise<{ bytes: Buffer; fingerprint: Awaited<ReturnType<typeof fingerprint>> }> {
  // Nonblocking prevents an unexpected FIFO from hanging before fstat can refuse it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw new VaultError('封存不是可安全读取的普通单链接文件');
    // Bound the read itself as well as the initial size check: another writer can grow a file after fstat.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > limit) throw new VaultError('封存文件超过读取上限');
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat({ bigint: true });
    const named = await fingerprint(path);
    if (!sameFingerprint(before, after) || !sameFingerprint(before, named)) throw new VaultError('封存文件在读取期间改变');
    return { bytes, fingerprint: named };
  } finally { await handle.close(); }
}

/** Opens one sealed entry; refuses a wrong format, an IV that is not 12 bytes and a tag that is not 16 bytes. */
function openSealed(name: string, text: string, key: Buffer): Uint8Array {
  let sealed: Sealed;
  try {
    sealed = JSON.parse(text) as Sealed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw unexpectedVaultReadError();
    throw new VaultError(`密钥库条目 ${name} 已损坏`);
  }
  if (sealed?.v !== FORMAT || typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.data !== 'string') {
    throw new VaultError(`密钥库条目 ${name} 的格式不对`);
  }
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) throw new VaultError(`密钥库条目 ${name} 的格式不对：初始向量或认证标签长度不对`);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(name));
  decipher.setAuthTag(tag);
  const first = decipher.update(Buffer.from(sealed.data, 'base64'));
  let last: Buffer;
  try { last = decipher.final(); }
  catch (error) {
    if (!(error instanceof Error) || error.constructor !== Error || Object.hasOwn(error, 'code')) throw unexpectedVaultReadError();
    throw new VaultError(`密钥库条目 ${name} 无法解开：内容被改动过，或文件名与封存时不同`);
  }
  return new Uint8Array(Buffer.concat([first, last]));
}

function associatedData(name: string): Buffer {
  return Buffer.from(`circle-hub vault v1\0${name}`, 'utf8');
}

function toBytes(value: string | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('vault values must be well-formed text');
    bytes = Buffer.from(value, 'utf8');
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw new TypeError('vault values are text or bytes');
  }
  if (bytes.byteLength > MAX_VALUE_BYTES) throw new TypeError(`vault values are at most ${MAX_VALUE_BYTES} bytes`);
  return bytes;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best effort.
  }
}
