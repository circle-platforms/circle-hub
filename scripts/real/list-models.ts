// Lists the model ids a provider section of the owner's environment file offers, so a model can be chosen for circle-home.ts.
// The key is read at run time and goes only into the request header; the screen shows the host name, the protocol, a status
// and the ids. Read-only: one GET of the model list.
//   node scripts/real/list-models.ts --env-file <file> --provider glm|qwen [--section <text>]
import { pick, readEnvFile, type EnvEntry } from './lib/env-file.ts';
import { endpointFrom } from './circle-home.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Model list URL and headers for a protocol, the way Circle asks (models.md): Anthropic `<base>/v1/models`, OpenAI `<base>/models`. */
export function listRequest(protocol: 'anthropic' | 'openai', baseUrl: string, apiKey: string): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, '');
  if (protocol === 'anthropic') {
    return { url: `${base.replace(/\/v1$/, '')}/v1/models`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } };
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } };
}

/** Ids out of the two answer shapes in use: { data: [{ id }] } and a bare array. */
export function idsOf(body: unknown): string[] {
  const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  return list.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string').sort();
}

export async function main(): Promise<number> {
  const provider = arg('provider');
  const envFile = arg('env-file');
  if ((provider !== 'glm' && provider !== 'qwen') || !envFile) {
    console.log('用法：--env-file <文件> --provider glm|qwen');
    return 2;
  }
  const entries: EnvEntry[] = readEnvFile(envFile);
  const section = arg('section');
  // A model name is not needed to list models: the section's own IST_MODEL, if any, is only a placeholder here.
  const endpoint = endpointFrom(entries, provider, pick(entries, 'IST_MODEL')?.value ?? 'unknown', section);
  const { url, headers } = listRequest(endpoint.protocol, endpoint.baseUrl, endpoint.apiKey);
  const host = new URL(url).host;
  console.log(`${provider}：协议 ${endpoint.protocol}，主机 ${host}，密钥长度 ${endpoint.apiKey.length}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  console.log(`状态 ${response.status}`);
  if (!response.ok) return 1;
  const ids = idsOf(await response.json());
  console.log(`模型 ${ids.length} 个：${ids.join('、')}`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: Error) => {
      console.log(`失败：${error.name}`);
      process.exitCode = 1;
    },
  );
}
