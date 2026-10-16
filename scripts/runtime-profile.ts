import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmod, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const help = `Usage: npm run runtime:profile -- --out <file> --circle-bin <dist/cli.js> --circle-commit <40-hex> --model-url <url>

Writes a development Circle runtime profile outside the git repository and prints the CIRCLE_RUNTIME_CONFIG export. The file mode is 0600. An API key is generated when --api-key is omitted and is not printed.

The template config/runtime-profile.development.example.json shows the shape. It is not loaded automatically.

Then export CIRCLE_RUNTIME_CONFIG to that file and start npm run dev:stack. dev:stack's second administrator approves the circle-runtime profile. Hub does not approve it by itself.

Environment fallbacks: CIRCLE_BIN, CIRCLE_COMMIT, CIRCLE_VERSION, CIRCLE_HUB_DEV_MODEL_URL, CIRCLE_HUB_DEV_MODEL_KEY.
Flags: --circle-version, --model, --api-key, --kind scripted|remote.
`;

export interface DevelopmentRuntimeInput {
  out: string;
  circleBin: string;
  circleCommit: string;
  circleVersion?: string;
  modelUrl: string;
  model?: string;
  apiKey?: string;
  kind?: 'scripted' | 'remote';
}

function fail(message: string): never {
  throw new Error(message);
}

function capture(command: string, args: string[], cwd?: string): Promise<{code: number; stdout: string}> {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {cwd, env: {PATH: process.env.PATH ?? ''}, stdio: ['ignore', 'pipe', 'ignore']});
    let stdout = '';
    const timer = setTimeout(() => {child.kill('SIGKILL'); resolvePromise({code: 1, stdout: ''});}, 5_000);
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.once('error', () => {clearTimeout(timer); resolvePromise({code: 1, stdout: ''});});
    child.once('exit', code => {clearTimeout(timer); resolvePromise({code: code ?? 1, stdout});});
  });
}

function validateModelUrl(value: string): string {
  let url: URL;
  try {url = new URL(value);} catch {fail('Model endpoints require HTTPS outside loopback');}
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || loopback)) fail('Model endpoints require HTTPS outside loopback');
  return url.href;
}

export async function writeDevelopmentRuntimeProfile(input: DevelopmentRuntimeInput): Promise<{generatedKey: boolean}> {
  if (!/^[a-f0-9]{40}$/.test(input.circleCommit)) fail('circleCommit must be 40 hexadecimal characters');
  const circleBin = resolve(input.circleBin);
  const out = resolve(input.out);
  const modelUrl = validateModelUrl(input.modelUrl);
  const reported = await capture(process.execPath, [circleBin, '--version']);
  const version = reported.stdout.trim();
  if (reported.code !== 0 || !version || (input.circleVersion && version !== input.circleVersion)) fail('The Circle executable did not report the expected version');
  const checkout = dirname(dirname(circleBin));
  const head = await capture('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  if (head.code === 0 && head.stdout.trim() && head.stdout.trim() !== input.circleCommit) fail('The checkout HEAD does not match circleCommit');
  const top = await capture('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (top.code === 0) {
    const root = top.stdout.trim();
    const fromRoot = relative(root, out);
    if (root && fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)) fail('Set --out to a file outside the repository');
  }
  const generatedKey = !input.apiKey;
  const apiKey = input.apiKey || randomBytes(32).toString('hex');
  const profile = {
    circleBin,
    circleCommit: input.circleCommit,
    circleVersion: version,
    model: {kind: input.kind ?? 'scripted', base_url: modelUrl, model: input.model ?? 'scripted-fixture', protocol: 'openai', api_key: apiKey},
  };
  try {
    await writeFile(out, `${JSON.stringify(profile, null, 2)}\n`, {mode: 0o600});
    await chmod(out, 0o600);
  } catch {fail('The profile file could not be written');}
  return {generatedKey};
}

export async function attachDevelopmentRuntime(scratch: string, env: NodeJS.ProcessEnv): Promise<{configured: boolean; notice?: string}> {
  if (env.CIRCLE_RUNTIME_CONFIG) return {configured: true};
  const circleBin = env.CIRCLE_BIN ?? '';
  const circleCommit = env.CIRCLE_COMMIT ?? '';
  const modelUrl = env.CIRCLE_HUB_DEV_MODEL_URL ?? '';
  if (!circleBin || !circleCommit || !modelUrl) return {configured: false, notice: '技能运行需要 Circle 运行配置。可执行 npm run runtime:profile -- --help 生成开发配置。'};
  try {
    await writeDevelopmentRuntimeProfile({
      out: `${scratch}/runtime.json`,
      circleBin,
      circleCommit,
      circleVersion: env.CIRCLE_VERSION || undefined,
      modelUrl,
      apiKey: env.CIRCLE_HUB_DEV_MODEL_KEY || undefined,
      kind: 'scripted',
    });
    env.CIRCLE_RUNTIME_CONFIG = `${scratch}/runtime.json`;
    return {configured: true, notice: '已根据 CIRCLE_BIN、CIRCLE_COMMIT 与 CIRCLE_HUB_DEV_MODEL_URL 写好开发运行配置。第二位管理员会批准 circle-runtime。'};
  } catch (error) {
    const message = error instanceof Error ? error.message : 'runtime profile setup failed';
    return {configured: false, notice: `未能自动写开发运行配置（${message}）。可执行 npm run runtime:profile。`};
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {process.stderr.write(help); return;}
  const circleBin = flag(args, '--circle-bin') ?? process.env.CIRCLE_BIN;
  const circleCommit = flag(args, '--circle-commit') ?? process.env.CIRCLE_COMMIT;
  const modelUrl = flag(args, '--model-url') ?? process.env.CIRCLE_HUB_DEV_MODEL_URL;
  const out = flag(args, '--out');
  if (!circleBin || !circleCommit || !modelUrl || !out) {process.stderr.write(help); process.exitCode = 2; return;}
  const kind = flag(args, '--kind') ?? 'scripted';
  if (kind !== 'scripted' && kind !== 'remote') {process.stderr.write(help); process.exitCode = 2; return;}
  try {
    const written = await writeDevelopmentRuntimeProfile({
      out,
      circleBin,
      circleCommit,
      circleVersion: flag(args, '--circle-version') ?? (process.env.CIRCLE_VERSION || undefined),
      modelUrl,
      model: flag(args, '--model'),
      apiKey: flag(args, '--api-key') ?? (process.env.CIRCLE_HUB_DEV_MODEL_KEY || undefined),
      kind,
    });
    process.stdout.write('Wrote a development runtime profile.\n');
    if (written.generatedKey) process.stdout.write('A model API key was generated and stored in the profile.\n');
    process.stdout.write(`export CIRCLE_RUNTIME_CONFIG=${resolve(out)}\n`);
    process.stdout.write('Start the hub with that variable set. npm run dev:stack asks the second administrator to approve circle-runtime.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'The profile file could not be written'}\n`);
    process.exitCode = 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);} catch {return import.meta.url === pathToFileURL(entry).href;}
}

if (invokedDirectly()) void main();
