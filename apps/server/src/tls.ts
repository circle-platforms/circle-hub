import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError } from '../../../packages/contracts/src/index.ts';
export async function serverTLS(configFile?: string) {
    if (!configFile)
        return undefined;
    try {
        const profile = z.object({ certFile: z.string().min(1), keyFile: z.string().min(1) }).strict().parse(JSON.parse(await readFile(configFile, 'utf8'))), [cert, key] = await Promise.all([readFile(profile.certFile), readFile(profile.keyFile)]);
        return { cert, key };
    }
    catch {
        throw new ApiError('INVALID_PAYLOAD', 'Server TLS profile is invalid or unavailable');
    }
}
