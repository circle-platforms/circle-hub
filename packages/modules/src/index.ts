import { ModuleInstallRequest, SkillPackSubmission, ScopeId, requireCondition, type AuthContext } from '../../contracts/src/index.ts';
import { verifyModule } from './verify.ts';
import type { SkillPacks } from '../../skillpacks/src/index.ts';
import type { SourceArtifacts } from '../../knowledge/src/source-artifacts.ts';
import type { Knowledge } from '../../knowledge/src/index.ts';
import type { Auth } from '../../tasks/src/auth.ts';
export class Modules {
    skills: SkillPacks;
    sources: SourceArtifacts;
    originals: Knowledge;
    auth: Auth;
    constructor(skills: SkillPacks, sources: SourceArtifacts, originals: Knowledge, auth: Auth) { this.skills = skills; this.sources = sources; this.originals = originals; this.auth = auth; }
    async install(ctx: AuthContext, value: unknown, requestedScope?: string) {
        const input = ModuleInstallRequest.parse(value), frozen = verifyModule(input.module, input.files), policy = await this.auth.check(ctx, 'assets.register'), scope = requestedScope ? ScopeId.parse(requestedScope) : policy.scopes.length === 1 ? policy.scopes[0] : null;
        requireCondition(scope, 'INVALID_PAYLOAD', 'Specify X-Scope-Id when more than one scope is authorized');
        await this.auth.check(ctx, 'assets.register', scope);
        if (frozen.module.kind === 'skill-pack') {
            requireCondition(input.trial, 'INVALID_PAYLOAD', 'A skill module requires a trial receipt');
            const submitted = await this.skills.submit(ctx, SkillPackSubmission.parse({ manifest: frozen.manifest, files: frozen.files, trial: input.trial, module: frozen.module }), scope), asset = await this.skills.assets.row(ctx, submitted.assetId, undefined, 'assets.register');
            return { ...submitted, moduleId: frozen.module.id, kind: frozen.module.kind, version: frozen.module.version, digest: frozen.module.digest, skillPackDigest: submitted.digest, lifecycle: asset.lifecycle };
        }
        return this.sources.store.transaction(async (tx) => {
            await this.auth.check(ctx, 'knowledge.read', scope, tx);
            const files = [];
            for (const file of frozen.files) {
                const source = await this.originals.storeOriginal(ctx, scope, file.path.split('/').at(-1)!, Buffer.from(file.base64, 'base64'), tx);
                files.push({ path: file.path, role: 'module-file', sourceRevisionId: source.sourceRevisionId, sha256: source.sha256 });
            }
            const asset = await this.sources.register(ctx, { scopeId: scope, name: `Module ${frozen.module.id}`, version: frozen.module.version, metadata: { module: frozen.module, manifest: frozen.manifest, usage: 'module-definition' }, files }, tx);
            return { moduleId: frozen.module.id, kind: frozen.module.kind, version: frozen.module.version, digest: frozen.module.digest, assetId: asset.assetId, assetVersion: asset.version, lifecycle: asset.lifecycle, assetSha256: asset.sha256 };
        });
    }
}
