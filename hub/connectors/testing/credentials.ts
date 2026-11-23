import { isAdmin } from '../../records/api.ts';
// Synthetic-only helpers: production callers must explicitly name every credential.
import { randomBytes } from 'node:crypto';
import { readProfile, ConnectorError, type Connectors, type AddResourceInput } from '../api.ts';
import { ResourceRecord } from '../../../contracts/src/resources.ts';
import { VariableInputError, secretNameOf } from '../../../contracts/src/variables.ts';
import { VariableError, type RecordsKit, type Principal } from '../../records/api.ts';
import type { PacksPort } from '../../ports.ts';
export async function addSyntheticResource(records: RecordsKit, packs: PacksPort, connectors: Connectors, by: Principal, input: AddResourceInput) {
    const handle = await packs.pack(input.system_pack);
    if (!handle || handle.kind !== 'system')
        return connectors.admin.addResource(by, input);
    const profile = await readProfile(handle);
    const names = profile.auth.kind === 'none' ? [] : profile.auth.kind === 'static_header' ? [profile.auth.credential] : profile.auth.credentials.map(c => c.name);
    const credentials = Object.fromEntries(names.map(name => [name, 'DEMO_' + randomBytes(10).toString('hex').toUpperCase()]));
    const resource = await connectors.admin.addResource(by, { ...input, credentials: { ...credentials, ...input.credentials } });
    await records.authorizations.grant(by, { permission: 'resource_assign', subject: '*', object: resource.id });
    return resource;
}
export async function setSyntheticCredentials(records: RecordsKit, connectors: Connectors, by: Principal, id: string, values: Record<string, string>) {
    const actual = await records.principals.get(by.id);
    if (!actual || actual.disabled || !isAdmin(actual))
        throw new ConnectorError('ACCESS_DENIED');
    const config = await records.authorizations.resourceConfig(id);
    if (!config?.body.bound)
        throw new ConnectorError('RESOURCE_INVALID', '合成资源不可用');
    const resource = ResourceRecord.parse(JSON.parse(Buffer.from((await records.objects.get(config.body.bound))!).toString()));
    if (!Object.keys(values).length)
        throw new ConnectorError('RESOURCE_INVALID', '没有给合成凭据');
    for (const value of Object.values(values))
        connectors.redactor.add(value);
    try {
        await records.variables.setSecrets(by, Object.entries(values).map(([item, value]) => {
            const name = secretNameOf(resource.credentials[item] ?? '');
            if (!name)
                throw new ConnectorError('RESOURCE_INVALID', '合成凭据项没有命名引用');
            return { name, value, digest_rule: resource.credential_digests[item], short: true };
        }), 'DEMO_SYNTHETIC_ROTATION');
    }
    catch (error) {
        if (error instanceof VariableError || error instanceof VariableInputError)
            throw new ConnectorError('RESOURCE_INVALID', '合成凭据值不合规则', { cause: error });
        throw error;
    }
}
export async function setSyntheticCredential(records: RecordsKit, connectors: Connectors, by: Principal, id: string, item: string, value: string) { return setSyntheticCredentials(records, connectors, by, id, { [item]: value }); }
export async function syntheticStoredCredential(records: RecordsKit, resource: ResourceRecord, item: string): Promise<string | null> {
    const name = secretNameOf(resource.credentials[item] ?? '');
    if (!name)
        return null;
    const metadata = await records.vault.secretMetadata(name);
    return metadata && !metadata.revoked ? (await records.vault.readSecret(name))?.value ?? null : null;
}
