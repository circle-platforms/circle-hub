// A credential-version stop is shared by resources and processes. Network I/O never holds a database transaction.
import { randomUUID } from 'node:crypto';
import { canonicalBytes, sha256Hex, type RecordStore, type Vault } from '../records/api.ts';
import { ConnectorError, type ConnectorErrorCode } from './errors.ts';
interface State {
    epoch: string;
    stopped: boolean;
    code?: ConnectorErrorCode;
    active: {
        id: string;
        until: number;
    } | null;
}
export class CredentialStop {
    readonly entry: string;
    readonly #store: RecordStore;
    readonly #vault: Vault;
    readonly #repair:string;
    constructor(store: RecordStore, vault: Vault, decisions: string[],names:readonly string[],resource:string) { this.#store = store; this.#vault = vault; this.#repair='circle-hub secret set '+[...new Set(names)].sort().map(name=>'--name '+name).join(' ')+' 或 circle-hub resource reset-login '+resource; this.entry = 'login-stop.' + sha256Hex(canonicalBytes([...new Set(decisions)].sort())); }
    async #read(): Promise<State> { const text = await this.#vault.getText(this.entry); if (!text)
        return { epoch: randomUUID(), stopped: false, active: null }; try {
        const s = JSON.parse(text);
        if (typeof s.epoch === 'string' && typeof s.stopped === 'boolean' && (s.active === null || typeof s.active?.id === 'string' && typeof s.active?.until === 'number'))
            return s;
    }
    catch { } throw new ConnectorError('STORE_FAILED', '密钥版本的登录停止记录不可读；请管理员 '+this.#repair); }
    async #change<T>(fn: (s: State) => Promise<T>) { return this.#store.withTransaction(async (tx) => { await this.#store.lock(this.entry, tx); return fn(await this.#read()); }); }
    async assertOpen() { const s = await this.#read(); if (s.stopped)
        throw new ConnectorError(s.code ?? 'LOGIN_FAILED', '这一版密钥登录已停止：请管理员 '+this.#repair, { detail: { stopped: true } }); }
    async status() { return this.#read(); }
    async epoch(): Promise<string> { return this.#change(async (s) => { await this.#vault.put(this.entry, canonicalBytes(s)); return s.epoch; }); }
    async reset() { await this.#change(async () => { await this.#vault.put(this.entry, canonicalBytes({ epoch: randomUUID(), stopped: false, active: null })); }); }
    async run<T>(fn: () => Promise<T>): Promise<T> {
        const id = randomUUID();
        for (;;) {
            const ready = await this.#change(async (s) => {
                if (s.stopped)
                    throw new ConnectorError(s.code ?? 'LOGIN_FAILED', '这一版密钥登录已停止：请管理员 '+this.#repair, { detail: { stopped: true } });
                if (s.active && s.active.until > Date.now())
                    return false;
                if (s.active) {
                    await this.#vault.put(this.entry, canonicalBytes({ ...s, stopped: true, active: null }));
                    throw new ConnectorError('LOGIN_FAILED', '上一回密钥使用的结果不明：请管理员 '+this.#repair, { detail: { stopped: true } });
                }
                await this.#vault.put(this.entry, canonicalBytes({ ...s, active: { id, until: Date.now() + 600000 } }));
                return true;
            });
            if (ready)
                break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        let stopped = false;
        let code: ConnectorErrorCode | undefined;
        try {
            return await fn();
        }
        catch (error) {
            code = error instanceof ConnectorError ? error.code : undefined;
            stopped = error instanceof ConnectorError && (error.code === 'LOGIN_FAILED' || error.code === 'CREDENTIAL_REFUSED') && error.detail.stopped === true;
            throw error;
        }
        finally {
            await this.#change(async (s) => { if (s.active?.id === id)
                await this.#vault.put(this.entry, canonicalBytes({ ...s, active: null, stopped: s.stopped || stopped, ...(stopped ? { code } : {}) })); });
        }
    }
}
