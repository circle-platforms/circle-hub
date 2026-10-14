import '../../contracts/src/hub-environment.ts';
import { readFile } from 'node:fs/promises';
import { ApiError, CLIENT_ROUTES, ScopeId, requireCondition } from '../../contracts/src/index.ts';
import { privateHttp } from '../../connectors/src/private-http.ts';
import { freezeModule } from './verify.ts';
export async function moduleCommand(args: string[]) {
    const command = args.shift(), options = new Map<string, string>();
    requireCondition(command === 'check' || command === 'install', 'INVALID_PAYLOAD', 'Usage: circle-hub modules check|install --catalog <modules.json> --module <id> [--trial <trial.json>] [--scope <scopeId>]');
    while (args.length) {
        const key = args.shift()!, value = args.shift();
        requireCondition(['--catalog', '--module', '--trial', '--scope'].includes(key) && value && !value.startsWith('--') && !options.has(key), 'INVALID_PAYLOAD', 'Invalid or duplicate module option');
        options.set(key, value);
    }
    requireCondition(options.has('--catalog') && options.has('--module'), 'INVALID_PAYLOAD', 'Module catalog and id are required');
    const frozen = await freezeModule(options.get('--catalog')!, options.get('--module')!);
    if (command === 'check') {
        console.log(JSON.stringify({ moduleId: frozen.module.id, kind: frozen.module.kind, version: frozen.module.version, digest: frozen.module.digest, fileCount: frozen.files.length }));
        return;
    }
    let trial: any;
    if (options.has('--trial')) {
        try {
            trial = JSON.parse(await readFile(options.get('--trial')!, 'utf8'));
        }
        catch {
            throw new ApiError('INVALID_PAYLOAD', 'Trial file is invalid or unavailable');
        }
    }
    requireCondition(frozen.module.kind !== 'skill-pack' || trial, 'INVALID_PAYLOAD', 'A skill module install requires --trial');
    let token = process.env.CIRCLE_HUB_TOKEN;
    if (!token && process.env.CIRCLE_HUB_TOKEN_FILE)
        token = (await readFile(process.env.CIRCLE_HUB_TOKEN_FILE, 'utf8')).trim();
    requireCondition(token, 'UNAUTHENTICATED', 'Set CIRCLE_HUB_TOKEN or CIRCLE_HUB_TOKEN_FILE');
    const scope = options.get('--scope') ?? process.env.CIRCLE_HUB_SCOPE, response = await privateHttp(new URL(CLIENT_ROUTES.moduleInstall.path, process.env.CIRCLE_HUB_URL ?? 'http://127.0.0.1:8080'), { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(scope ? { 'x-scope-id': ScopeId.parse(scope) } : {}) }, body: JSON.stringify({ module: frozen.module, files: frozen.files, ...(trial ? { trial } : {}) }), caFile: process.env.CIRCLE_HUB_CA_FILE, caSha256: process.env.CIRCLE_HUB_CA_SHA256 });
    if (response.status < 200 || response.status >= 300)
        throw new ApiError(response.body?.error?.code ?? 'SOURCE_UNREACHABLE', response.body?.error?.message ?? 'Module submission failed', response.body?.error?.details ?? {});
    requireCondition(response.body?.data, 'SOURCE_UNREACHABLE', 'Module receipt is malformed');
    console.log(JSON.stringify(response.body.data));
}
