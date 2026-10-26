// Named deployment data. Values are never interpolated; only complete references are replaced once.
import { z } from 'zod';
import { VARIABLE_KIND, isVariableKind, DigestRuleSchema, type VariableKind } from '../generated/vocabulary.ts';
import { idOf, JsonPointer, Sha256 } from './common.ts';
export const SECRET_NAME_SEGMENTS = ['KEY', 'PASS', 'PWD', 'PIN', 'OTP', 'AUTH', 'CERT', 'SALT', 'HMAC', 'COOKIE', 'BEARER', 'SIGNATURE', 'AUTHORIZATION'] as const;
export const SECRET_NAME_PARTS = ['PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'CREDENTIAL', 'PRIVATE', 'API_KEY'] as const;
export function secretLikeName(name: string): boolean { return name.split('_').some(part => (SECRET_NAME_SEGMENTS as readonly string[]).includes(part)) || SECRET_NAME_PARTS.some(part => name.includes(part)); }
export const VariableName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, '名字须以大写字母开头，只含大写字母、数字和下划线，至多 64 个字符').refine(name => !name.startsWith('CIRCLE_HUB_') && !name.startsWith('CIRCLE_SERVER_'), '名字不能使用进程配置保留前缀或退役前缀');
/** The legacy vault-entry syntax remains separate, solely for historical definitions. */
export const SecretReference = z.string().regex(/^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/, '凭据写成 ${secret:名字}').refine(value => VariableName.safeParse(value.slice(9,-1)).success, '凭据引用的名字不合规则');
export function secretNameOf(value: string): string | null { const parsed = SecretReference.safeParse(value); return parsed.success ? value.slice(value.indexOf(':') + 1, -1) : null; }
export const OrdinaryVariableName = VariableName.refine(name => !secretLikeName(name), '名字像密钥；请用 circle-hub secret set --name <名字>');
export interface ValueReference {
    at: string;
    kind: VariableKind;
    name: string;
}
export class VariableInputError extends Error {
    readonly at: string;
    constructor(message: string, at = '') { super(message); this.at = at; }
}
const part = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function reference(value: string, at: string): ValueReference | null {
    if (!VARIABLE_KIND.some(kind => value.toLowerCase().includes('${' + kind + ':')))
        return null;
    const matched = /^\$\{([a-z_]+):([^{}]+)\}$/.exec(value);
    if (!matched || !isVariableKind(matched[1]) || !VariableName.safeParse(matched[2]).success)
        throw new VariableInputError('引用必须占满一个值，写成 ${var:名字} 或 ${secret:名字}；名字按大写规则填写，不拼接', at);
    return { at, kind: matched[1], name: matched[2] };
}
export function referencesIn(value: unknown): ValueReference[] {
    const found: ValueReference[] = [];
    const ancestors = new Set<object>();
    const visit = (node: unknown, at: string) => {
        if (typeof node === 'string') {
            const ref = reference(node, at);
            if (ref)
                found.push(ref);
            return;
        }
        if (node === null || typeof node !== 'object')
            return;
        if (ancestors.has(node))
            throw new VariableInputError('值不是无环 JSON', at);
        ancestors.add(node);
        if (Array.isArray(node))
            node.forEach((child, index) => visit(child, at + '/' + index));
        else
            for (const [key, child] of Object.entries(node))
                visit(child, at + '/' + part(key));
        ancestors.delete(node);
    };
    visit(value, '');
    return found;
}
export function resolve(value: unknown, lookup: (kind: VariableKind, name: string, at: string) => unknown): unknown {
    referencesIn(value); // Validate the whole tree before invoking a lookup.
    const visit = (node: unknown, at: string): unknown => {
        if (typeof node === 'string') {
            const ref = reference(node, at);
            return ref ? lookup(ref.kind, ref.name, at) : node;
        }
        if (Array.isArray(node))
            return node.map((child, index) => visit(child, at + '/' + index));
        if (node !== null && typeof node === 'object')
            return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child, at + '/' + part(key))]));
        return node;
    };
    return visit(value, '');
}
function validValue(value: unknown): boolean {
    try {
        const seen = new Set<object>();
        const visit = (v: unknown): boolean => {
            if (v === null || typeof v === 'boolean')
                return true;
            if (typeof v === 'number')
                return Number.isFinite(v);
            if (typeof v === 'string')
                return v.isWellFormed() && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v) && !reference(v, '');
            if (typeof v !== 'object' || seen.has(v))
                return false;
            if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
                return false;
            seen.add(v);
            const valid = Array.isArray(v) ? Array.from(v).every(visit) : Object.entries(v).every(([key, child]) => key !== '$value' && key.isWellFormed() && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(key) && !reference(key, '') && visit(child));
            seen.delete(v);
            return valid;
        };
        // Key ordering does not change UTF-8 byte length; native JSON number/string rendering is RFC 8785's rendering.
        return visit(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536;
    }
    catch {
        return false;
    }
}
export const VariableValue = z.unknown().superRefine((value, ctx) => { if (!validValue(value))
    ctx.addIssue({ code: 'custom', message: '值须为至多 64 KiB 的规范 JSON；不含嵌套引用、运行时绑定或非法控制字符' }); });
export function validateSecret(value: unknown, short = false): string {
    if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(value) || [...value].length < (short ? 1 : 8) || [...value].length > 4096)
        throw new VariableInputError('密钥须为一行、不含控制字符的文本，8 到 4096 个字符；短值须显式给 --short <名字>');
    return value;
}
export const VariableRecord = z.strictObject({ schema: z.literal('variable@1'), name: OrdinaryVariableName, value: VariableValue });
export type VariableRecord = z.infer<typeof VariableRecord>;
export const SecretConsumer = z.strictObject({ definition: z.union([idOf('res'), idOf('exe')]), item: z.string().min(1).max(100), sends_to: Sha256 });
export type SecretConsumer = z.infer<typeof SecretConsumer>;
export const SecretRecord = z.strictObject({ schema: z.literal('secret@1'), name: VariableName, entry: z.string().regex(/^secret\.[a-z][a-z0-9_]{0,63}\.[a-f0-9]{24}$/), digest_rule: DigestRuleSchema, length: z.number().int().min(1).max(4096), consumers: z.array(SecretConsumer).min(1) });
export type SecretRecord = z.infer<typeof SecretRecord>;
export const VariableUse = z.strictObject({ at: z.string().min(1).max(2000).refine(value => { const split = value.indexOf('#'); return split > 0 && JsonPointer.safeParse(value.slice(split + 1)).success; }, 'a definition or package followed by # and a JSON pointer'), name: VariableName, decision: Sha256 });
export type VariableUse = z.infer<typeof VariableUse>;
export const VariableDeclaration = z.strictObject({ name: OrdinaryVariableName, description: z.string().min(1).max(2000), schema: z.record(z.string(), z.unknown()), default: VariableValue });
export type VariableDeclaration = z.infer<typeof VariableDeclaration>;
export const schemas: Record<string, z.ZodType> = { 'variable@1': VariableRecord, 'secret@1': SecretRecord };
