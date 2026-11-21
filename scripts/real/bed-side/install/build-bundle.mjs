// Offline bundling only: read immutable Git blobs and explicit files; never execute Python or contact a Hub/gateway.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const runtimeFiles = ['entry.py', 'cell_gateway.py', 'cell_runtime.py', 'table_cell.py', 'test_xlsx.py'];
const sourceDirectory = 'scripts/real/bed-side/';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new Error('Required source commit or runtime file is unavailable in the local Git object store');
  return result.stdout;
}
function file(path) {
  try {
    if (!path || !lstatSync(path).isFile()) throw new Error();
    return readFileSync(path);
  } catch { throw new Error('An explicit regular input file is required'); }
}
function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Explicit operator input is not valid JSON'); }
}

export function buildBundle({repo, commit, out, installer, observer, probe = fileURLToPath(new URL('./probe.py', import.meta.url)), baseHubContract, objectsFile, release}) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('An explicit full 40-character commit SHA is required');
  if (git(repo, ['cat-file', '-t', commit]).toString().trim() !== 'commit') throw new Error('Source identity must be a commit object');
  const releaseName = release ?? `cell-${commit.slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(releaseName)) throw new Error('Invalid release name');
  const target = resolve(out);
  if (existsSync(target)) throw new Error('Bundle output must not already exist');
  const components = runtimeFiles.map(name => [name, git(repo, ['show', `${commit}:${sourceDirectory}${name}`])]);
  const installerBytes = file(installer), observerBytes = file(observer), probeBytes = file(probe);
  const base = baseHubContract === undefined ? null : file(baseHubContract);
  if (base !== null) json(base); // Syntax only; source contract/identity validation belongs to the installer.
  const objects = objectsFile === undefined ? null : json(file(objectsFile));
  if (objects !== null && (!Array.isArray(objects) || objects.length === 0 || objects.some(value => typeof value !== 'string' || value.trim().length === 0) || new Set(objects).size !== objects.length)) throw new Error('Object inventory must be a nonempty JSON array of distinct exact names');
  const missing_requirements = [];
  if (base === null) missing_requirements.push('base-hub-contract.json');
  if (objects === null) missing_requirements.push('objects');
  const plan = {
    release: releaseName, source_commit: commit,
    component_sha256: Object.fromEntries(components.map(([name, bytes]) => [name, digest(bytes)])),
    base_hub_sha256: base === null ? null : digest(base),
    checker_sha256: digest(observerBytes), installer_sha256: digest(installerBytes), probe_sha256: digest(probeBytes),
    objects, missing_requirements,
  };
  mkdirSync(dirname(target), {recursive: true});
  const staging = mkdtempSync(join(dirname(target), '.cell-bundle-'));
  try {
    mkdirSync(join(staging, 'bed-side'), {mode: 0o700});
    mkdirSync(join(staging, 'install'), {mode: 0o700});
    for (const [name, bytes] of components) writeFileSync(join(staging, 'bed-side', name), bytes, {mode: 0o600});
    writeFileSync(join(staging, 'install', 'installer.py'), installerBytes, {mode: 0o700});
    writeFileSync(join(staging, 'install', 'observe.py'), observerBytes, {mode: 0o700});
    writeFileSync(join(staging, 'install', 'probe.py'), probeBytes, {mode: 0o700});
    if (base !== null) writeFileSync(join(staging, 'base-hub-contract.json'), base, {mode: 0o600});
    writeFileSync(join(staging, 'install-plan.json'), JSON.stringify(plan, null, 2) + '\n', {mode: 0o600});
    if (existsSync(target)) throw new Error('Bundle output appeared during construction');
    renameSync(staging, target);
  } finally { rmSync(staging, {recursive: true, force: true}); }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: Object.fromEntries(['repo','commit','out','installer','observer','probe','base-hub-contract','objects-file','release'].map(name => [name, {type:'string'}]))});
    if (!values.commit || !values.out) throw new Error('Required: --commit FULL_SHA --out NEW_DIRECTORY');
    const here = dirname(fileURLToPath(import.meta.url));
    const plan = buildBundle({repo: resolve(values.repo ?? '.'), commit: values.commit, out: values.out, installer: values.installer ?? join(here,'installer.py'), observer: values.observer ?? join(here,'observe.py'), probe: values.probe ?? join(here,'probe.py'), baseHubContract: values['base-hub-contract'], objectsFile: values['objects-file'], release: values.release});
    // No object identities, configuration content, credentials or local paths in stdout.
    console.log(JSON.stringify({source_commit: plan.source_commit, component_sha256: plan.component_sha256, checker_sha256: plan.checker_sha256, installer_sha256: plan.installer_sha256, probe_sha256: plan.probe_sha256, base_hub_sha256: plan.base_hub_sha256, object_count: plan.objects?.length ?? null, missing_requirements: plan.missing_requirements}));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Offline bundle construction failed'); process.exitCode = 1; }
}
