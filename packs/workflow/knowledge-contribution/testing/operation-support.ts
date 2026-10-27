import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const SESSION = 'circle-synthetic-operation';
export const TOKEN = 'FictCaptureToken42';
export const ROOT = 'a'.repeat(64);
export const PACK_DIGEST = 'c'.repeat(64);

export interface Result { code: number | null; out: string; err: string }
export interface Scratch { home: string; skill: string; entry: string; tokenFile: string; env: NodeJS.ProcessEnv }

export async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<Scratch> {
  const home = await mkdtemp(join(tmpdir(), 'operation-capture-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skill = join(home, 'skills', 'operation-capture');
  await cp(new URL('../tools/operation-capture/', import.meta.url), skill, { recursive: true });
  const tokenFile = join(home, 'capture.token');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env = { CIRCLE_HOME: home, HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  return { home, skill, entry: join(skill, 'operation.ts'), tokenFile, env };
}

export function execute(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string | Uint8Array, cwd?: string, shell = false): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, shell });
    let out = '';
    let err = '';
    child.stdout.on('data', value => { out += value; });
    child.stderr.on('data', value => { err += value; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

export async function hookInput(scratch: Scratch, input: string | Uint8Array, env = scratch.env): Promise<Result> {
  const definition = JSON.parse(await readFile(join(scratch.skill, 'hooks.json'), 'utf8')).hooks.after_tool[0];
  return execute(definition.command, [], env, input, undefined, true);
}

export async function hook(scratch: Scratch, output: string, input: Record<string, unknown> = {}, session = SESSION): Promise<Result> {
  const definition = JSON.parse(await readFile(join(scratch.skill, 'hooks.json'), 'utf8')).hooks.after_tool[0];
  return hookInput(scratch, JSON.stringify({
    event: 'after_tool',
    session_id: session,
    cwd: '/synthetic/workspace',
    hook: definition.name,
    source: 'skill',
    source_label: 'operation-capture',
    tool_name: 'execute',
    tool_input: { command: 'orbit synthetic-status', ...input },
    paths: [],
    tool_output: output,
    tool_status: 'success',
  }));
}

export function skill(scratch: Scratch, args: string[]): Promise<Result> {
  return execute(process.execPath, [scratch.entry, ...args], scratch.env, undefined, scratch.home);
}

export async function enable(scratch: Scratch, url: string): Promise<Result> {
  return skill(scratch, ['enable', '--session', SESSION, '--hub', url, '--token-file', scratch.tokenFile]);
}

interface StoredUpload { bytes: Buffer; provenance: string }
async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function fakeHub(t: { after(fn: () => Promise<void>): void }, options: { delayUploadMs?: number; onRequest?: (input: any) => void | Promise<void> } = {}) {
  const requests: Array<{ headers: IncomingMessage['headers']; body: any }> = [];
  const attempts: Array<{ headers: IncomingMessage['headers']; body: any }> = [];
  const uploads = new Map<string, StoredUpload>();
  const runs: any[] = [];
  const submissions: any[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const input = await body(request);
      attempts.push({ headers: request.headers, body: input });
      await options.onRequest?.(input);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end('{}');
        return;
      }
      requests.push({ headers: request.headers, body: input });
      let result: any = {};
      if (input.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-hub', version: '1' } };
      } else if (input.method === 'tools/call') {
        const name = input.params.name as string;
        const args = input.params.arguments;
        let value: any;
        if (name === 'upload_file') {
          if (options.delayUploadMs) await new Promise(resolve => setTimeout(resolve, options.delayUploadMs));
          const bytes = Buffer.from(args.file_path, 'base64');
          const digest = createHash('sha256').update(bytes).digest('hex');
          uploads.set(digest, { bytes, provenance: args.provenance_type ?? 'declared' });
          value = { call_result: 'ok', errors: [], trace: 'b'.repeat(32), acceptance: 'accepted', reference: `src:${digest}`, sha256: digest, size: bytes.length, media_type: args.media_type ?? 'text/plain' };
        } else if (name === 'start_run') {
          runs.push(args);
          value = { call_result: 'ok', errors: [], trace: 'b'.repeat(32), run: { run: 'run_01arz3ndektsv4rrffq69g5fav', pack: 'knowledge-contribution@1.3.1', pack_digest: PACK_DIGEST, product: args.product, root: ROOT } };
        } else if (name === 'submit_result') {
          submissions.push(args);
          const errors: any[] = [];
          for (const item of args.items) {
            for (const contribution of item.slots?.contribution ?? []) {
              const data = contribution.data;
              const upload = uploads.get(data.feeding?.source?.bytes);
              if (!upload || upload.provenance !== 'client_captured') errors.push({ code: 'SYNTHETIC_PROVENANCE', item: item.item });
              const quotes = data.feeding?.schema === 'fed-observation@1' ? [data.feeding.result] : data.feeding?.schema === 'fed-procedure@1' ? data.feeding.steps.map((step: any) => step.quote) : [data.feeding?.quote];
              for (const quote of quotes) {
                const line = Number(quote.reference.split('/').at(-1));
                const text = upload?.bytes.toString('utf8').split(/\r\n|\r|\n/)[line - 1];
                if (!text?.includes(quote.text)) errors.push({ code: 'SYNTHETIC_QUOTE', item: item.item });
              }
            }
          }
          value = { call_result: 'ok', errors, trace: 'b'.repeat(32), acceptance: errors.length ? 'not_accepted' : 'accepted', result: { contributions: { stored: errors.length ? [] : args.items.map((_: unknown, index: number) => ({ record: `${index + 1}`.repeat(64) })) } } };
        } else {
          value = { call_result: 'error', errors: [{ code: 'SYNTHETIC_UNKNOWN_TOOL' }], trace: 'b'.repeat(32) };
        }
        result = { content: [{ type: 'text', text: value.acceptance === 'not_accepted' ? '合成拒绝回执' : '合成受理回执' }], structuredContent: value };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' }).end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, attempts, uploads, runs, submissions };
}
