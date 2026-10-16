import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ApiError, ModuleCatalog, ModuleEntry, ModuleBytes, MAX_SOURCE_BYTES, requireCondition, sha256 } from '../../contracts/src/index.ts';
import {verifyProductLine} from '../../methods/src/product-modules.ts';
function reportManifest(errors:{code:string;message:string}[]):void{if(errors.length)throw new ApiError(errors[0].code,errors.map(item=>item.message).join('; '),{manifestErrors:errors});}
export function verifyModule(entry: unknown, input: unknown) {
    const module = ModuleEntry.parse(entry), files = ModuleBytes.parse(input), directory = module.kind === 'skill-pack' ? 'skills' : 'products', manifestName = module.kind === 'skill-pack' ? 'skillpack.json' : 'product-line.json';
    const structural:{code:string;message:string}[]=[];
    if(!(module.root === `${directory}/${module.id}` && module.manifestPath === `${module.root}/${manifestName}`))structural.push({code:'INVALID_PAYLOAD',message:'Module id root and manifestPath differ'});
    if(!(new Set(module.files.map(file => file.path)).size === module.files.length && module.files.every((file, index) => index === 0 || module.files[index - 1].path < file.path)))structural.push({code:'INVALID_PAYLOAD',message:'Module file paths must be unique and sorted'});
    if(sha256(module.files.map(file => `${file.sha256}  ${file.path}\n`).join('')) !== module.digest)structural.push({code:'SOURCE_HASH_MISMATCH',message:'Module file manifest digest differs'});
    if(!(new Set(files.map(file => file.path)).size === files.length && files.length === module.files.length))structural.push({code:'SOURCE_HASH_MISMATCH',message:'Frozen file set differs from the module'});
    reportManifest(structural);
    const supplied = new Map(files.map(file => [file.path, file])), frozen = [], fileErrors:{code:string;message:string}[]=[];
    let total = 0;
    for (const file of module.files) {
        const original = supplied.get(file.path);
        if(!original){fileErrors.push({code:'SOURCE_HASH_MISMATCH',message:'Frozen module file is missing'});continue;}
        const bytes = Buffer.from(original.base64, 'base64');
        total += bytes.length;
        if(total > MAX_SOURCE_BYTES)fileErrors.push({code:'BODY_TOO_LARGE',message:'Module originals exceed sixteen MiB'});
        if(!(original.sha256 === file.sha256 && sha256(bytes) === file.sha256))fileErrors.push({code:'SOURCE_HASH_MISMATCH',message:'Frozen module file differs from the declared SHA'});
        else if(total<=MAX_SOURCE_BYTES)frozen.push({ ...original });
    }
    reportManifest(fileErrors);
    const manifestFile = frozen.find(file => file.path === manifestName);
    requireCondition(manifestFile, 'INVALID_PAYLOAD', 'Module manifest is not in its file set');
    let manifest: any;
    try {
        const bytes = Buffer.from(manifestFile.base64, 'base64'), text = bytes.toString('utf8');
        requireCondition(Buffer.from(text).equals(bytes), 'INVALID_PAYLOAD', 'Module manifest is not UTF-8');
        manifest = JSON.parse(text);
    }
    catch {
        throw new ApiError('INVALID_PAYLOAD', 'Module manifest is not valid UTF-8 JSON');
    }
    requireCondition(manifest && typeof manifest === 'object' && !Array.isArray(manifest) && manifest.id === module.id && manifest.version === module.version, 'INVALID_PAYLOAD', 'Module identity differs from its own manifest');
    if (module.kind === 'product-line'){
        requireCondition(manifest.schemaVersion === 'product-line/1', 'UNSUPPORTED_VERSION', 'Product line manifest version is unsupported');
        verifyProductLine(manifest,new Map(frozen.map(file=>[file.path,Buffer.from(file.base64,'base64').toString('utf8')])));
    }
    return { module, files: frozen, manifest };
}
async function bytes(path: string, budget = MAX_SOURCE_BYTES) { let handle; try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    requireCondition(stat.isFile(), 'INVALID_PAYLOAD', 'Module input must be a regular file');
    requireCondition(stat.size <= budget, 'BODY_TOO_LARGE', 'Module originals exceed sixteen MiB');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0)
            break;
        length += read.bytesRead;
    }
    requireCondition(length === stat.size, 'SOURCE_HASH_MISMATCH', 'Module file changed while being frozen');
    return buffer.subarray(0, length);
}
catch (error) {
    if (error instanceof ApiError)
        throw error;
    throw new ApiError('INVALID_PAYLOAD', 'Module file is unavailable or unsafe');
}
finally {
    await handle?.close();
} }
export async function freezeModule(catalogFile: string, id: string) {
    let catalog;
    try {
        catalog = ModuleCatalog.parse(JSON.parse((await bytes(catalogFile)).toString('utf8')));
    }
    catch (error) {
        if (error instanceof ApiError)
            throw error;
        throw new ApiError('INVALID_PAYLOAD', 'Module catalog is invalid');
    }
    const module = catalog.modules.find(module => module.id === id);
    requireCondition(module, 'INVALID_PAYLOAD', 'Module id is absent from the catalog');
    const base = dirname(catalogFile), root = join(base, module.root), paths: string[] = [];
    let count = 0;
    for (const segment of [base, join(base, module.root.split('/')[0]), root]) {
        const stat = await lstat(segment);
        requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_PAYLOAD', 'Module directory must not be a symlink');
    }
    const walk = async (directory: string, prefix = '') => { for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.'))
            continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        requireCondition(!entry.isSymbolicLink(), 'INVALID_PAYLOAD', 'Module symlinks are not supported');
        if (entry.isDirectory()) {
            requireCondition(++count <= 1000, 'RESULT_TOO_LARGE', 'Module directory count exceeds its bound');
            await walk(join(directory, entry.name), path);
        }
        else {
            requireCondition(entry.isFile(), 'INVALID_PAYLOAD', 'Module files must be regular');
            paths.push(path);
            requireCondition(paths.length <= 100, 'RESULT_TOO_LARGE', 'Module file count exceeds one hundred');
        }
    } };
    await walk(root);
    paths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    requireCondition(JSON.stringify(paths) === JSON.stringify(module.files.map(file => file.path)), 'SOURCE_HASH_MISMATCH', 'Module catalog differs from the nonhidden file set');
    const files = [];
    let total = 0;
    for (const file of module.files) {
        const original = await bytes(join(root, file.path), MAX_SOURCE_BYTES - total);
        total += original.length;
        files.push({ path: file.path, base64: original.toString('base64'), sha256: sha256(original) });
    }
    return verifyModule(module, files);
}
