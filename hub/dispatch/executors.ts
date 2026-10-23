import { canonicalBytes, newId, scanForCredentials, type Principal, type RecordsKit } from '../records/api.ts';
import { ExecutorDefinition } from './definition.ts';
export type RegisteredExecutor = { id: string; digest: string; definition: ExecutorDefinition };
export class ExecutorRegistry {
  readonly records: RecordsKit;
  constructor(records: RecordsKit) { this.records = records; }
  async admin(by: Principal): Promise<void> {
    const current = await this.records.principals.get(by.id);
    if (!current || current.disabled || current.role !== 'admin') throw new Error('只有启用中的管理员能操作执行器和作业');
  }
  async add(by: Principal, input: unknown, secret: string): Promise<RegisteredExecutor> {
    await this.admin(by);
    if (!secret.trim() || secret.length > 4096 || /[\r\n]/.test(secret)) throw new Error('执行器密钥必须非空且为单行');
    const id = newId('exe');
    const definition = this.validate({ ...(input as object), id });
    if (containsSecret(definition, secret)) throw new Error('执行器定义不能包含调用密钥');
    await this.records.vault.put(`executor.${id}.bearer`, secret);
    try { return await this.configure(by, definition); } catch (e) { await this.records.vault.remove(`executor.${id}.bearer`); throw e; }
  }
  async update(by: Principal, id: string, input: unknown, nextSecret?: string): Promise<RegisteredExecutor> {
    await this.admin(by); if (!await this.get(id)) throw new Error('执行器对你不可用');
    const definition = this.validate({ ...(input as object), id });
    const secret = await this.records.vault.getText(`executor.${id}.bearer`);
    if (secret && containsSecret(definition, secret)) throw new Error('执行器定义不能包含调用密钥');
    if (nextSecret !== undefined) {
      if (!nextSecret.trim() || nextSecret.length > 4096 || /[\r\n]/.test(nextSecret) || containsSecret(definition, nextSecret)) throw new Error('执行器定义或新密钥无效，密钥不能出现在定义里');
      await this.configure(by, { ...definition, enabled: false });
      await this.records.vault.put(`executor.${id}.bearer`, nextSecret);
    }
    return this.configure(by, definition);
  }
  async setSecret(by: Principal, id: string, secret: string): Promise<void> {
    await this.admin(by); const current = await this.get(id);
    if (!current || !secret.trim() || secret.length > 4096 || /[\r\n]/.test(secret)) throw new Error('执行器或密钥无效');
    if (containsSecret(current.definition, secret)) throw new Error('执行器定义不能包含调用密钥');
    await this.update(by, id, current.definition, secret);
  }
  async disable(by: Principal, id: string): Promise<RegisteredExecutor> {
    const current = await this.get(id); if (!current) throw new Error('执行器对你不可用');
    await this.admin(by);
    return this.configure(by, this.validate({ ...current.definition, enabled: false }));
  }
  async get(id: string): Promise<RegisteredExecutor | null> {
    if (!/^exe_[0-9a-hjkmnp-tv-z]{26}$/.test(id)) return null;
    const auth = await this.records.authorizations.resourceConfig(`executor.${id}`);
    if (!auth?.body.bound) return null;
    const bytes = await this.records.objects.get(auth.body.bound);
    if (!bytes) throw new Error('执行器定义字节缺失');
    const definition = this.validate(JSON.parse(new TextDecoder().decode(bytes)));
    if (definition.id !== id) throw new Error('执行器定义身份不符');
    return { id, digest: auth.body.bound, definition };
  }
  async list(by: Principal): Promise<RegisteredExecutor[]> {
    await this.admin(by);
    const ids = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await this.records.authorizations.history({ permission: 'resource_config', limit: 500, ...(cursor ? { cursor } : {}) });
      for (const r of page.items) if (r.body.object.startsWith('executor.')) ids.add(r.body.object.slice('executor.'.length));
      cursor = page.next;
    } while (cursor);
    const entries = await Promise.all([...ids].sort().map(id => this.get(id)));
    return entries.filter((e): e is RegisteredExecutor => e !== null);
  }
  private validate(input: unknown): ExecutorDefinition {
    let parsed: ReturnType<typeof ExecutorDefinition.safeParse>;
    try { parsed = ExecutorDefinition.safeParse(input); } catch { throw new Error('执行器定义无效：结构过深或格式不能安全读取'); }
    if (!parsed.success) throw new Error('执行器定义无效：请核对端点、固定 CA、工具、映射和必需字段');
    let findings: number;
    try { findings = scanForCredentials(canonicalBytes(parsed.data)).findings.length; } catch { throw new Error('执行器定义不是可规范化的 JSON；不要内嵌凭据或不合法取值'); }
    if (findings) throw new Error('执行器定义不能含凭据，密钥只经标准输入写入密钥库');
    return structuredClone(parsed.data);
  }
  private async configure(by: Principal, definition: ExecutorDefinition): Promise<RegisteredExecutor> {
    const stored = await this.records.objects.put(canonicalBytes(definition), 'application/json');
    await this.records.authorizations.configureResource(by, `executor.${definition.id!}`, stored.sha256);
    return { id: definition.id!, digest: stored.sha256, definition };
  }
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(v => containsSecret(v, secret));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => key.includes(secret) || containsSecret(child, secret));
  return false;
}
