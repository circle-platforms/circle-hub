import {catalogFor} from '../testing/command-catalog.ts';
import IDENTITIES from '../examples/command-identities-v2.json' with {type:'json'};
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
// Synthetic fixtures; original-format contract and runtime profile use invented runner identifiers.
import { runtimeDocument, typedRuntimeDocument, profileDocument } from '../testing/runtime.ts';
import { parseRuntimeContract, runtimeDigest, type RuntimeContract } from './runtime-contract.ts';
import { parseManifest, type ManifestBed } from './manifest.ts';
import type { PlanSlots } from './slots.ts';
import type { PlanSubject } from './subject.ts';
export const COMMAND_IDENTITIES=structuredClone(IDENTITIES.command_identities) as CommandIdentity[];
export const COMMAND_CATALOG=catalogFor(COMMAND_IDENTITIES);
const interval61=structuredClone(COMMAND_IDENTITIES[0]);interval61.parameters[0].raw='61';interval61.parameters[0].parsed={kind:'int',value:61};COMMAND_IDENTITIES.push(interval61);
export const CONTRACT_DOC = typedRuntimeDocument();
CONTRACT_DOC.effects.effect_0.commands.push(interval61 as typeof CONTRACT_DOC.effects.effect_0.commands[number]);
CONTRACT_DOC.contract_sha256=runtimeDigest(CONTRACT_DOC);
export const LEGACY_CONTRACT_DOC=runtimeDocument();
export const LEGACY_PROFILE_DOC=profileDocument(LEGACY_CONTRACT_DOC);
export const PROFILE_DOC = profileDocument(CONTRACT_DOC);
export const AUTOID = '990000000000000031';
export const MANIFEST_DOC = {
  schema: 'test-bed-manifest@1',
  beds: [
    {
      name: 'bed-a',
      devices: [
        { name: 'dut0', type: 'load-balancer', product: 'widget', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: ['2001:db8:1::10/64'] },
        { name: 'dut1', type: 'load-balancer', product: 'widget', ipv4: ['192.0.2.130/26'], ipv6: [] },
        { name: 'router0', type: 'router', product: null, ipv4: ['192.0.2.1/26'], ipv6: ['2001:db8:1::1/64'] },
        { name: 'client0', type: 'client', product: null, ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', product: null, ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', product: null, ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [
        { host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 },
        { host: 'client0', ip: '192.0.2.80', proto: 'tcp', port: 9000 },
      ],
      reserved: [],
    },
  ],
};


export function contractOf(doc: unknown = CONTRACT_DOC): RuntimeContract { const r = parseRuntimeContract(doc); if (!r.ok) throw new Error(JSON.stringify(r.problems)); return r.contract; }
export function bedsOf(doc: unknown = MANIFEST_DOC): ManifestBed[] { const r = parseManifest(doc); if (!r.ok) throw new Error(JSON.stringify(r.problems)); return r.beds; }
export const QUOTE = { reference: `src:${'a'.repeat(64)}/kityminder@1/s/c-1-e1`, text: '健康检查间隔设置成功' };
export function goodData(): PlanSlots { return { bucket: 'bed-a', blocks: [], replacements: [], steps: [
  { object: 'widget-seat', method: 'configure', args: ['widget health interval 60'], keywords: {} },
  { object: 'widget-host', method: 'shell', args: ['echo 192.0.2.90'], keywords: {} },
  { object: 'widget-clock', method: 'pause', args: ['1'], keywords: {} },
], expects: [{ text: '健康检查间隔设置成功', quote: { ...QUOTE }, after: 1 }] }; }
export function subjectOf(data: unknown, options: { contractDoc?: unknown; profileDoc?: unknown; manifestDoc?: unknown; leases?: PlanSubject['leases']; item?: string; caseTexts?: string[]; criteria?: PlanSubject['criteria'] } = {}): { subject: PlanSubject } { return { subject: { command_catalog:structuredClone(COMMAND_CATALOG),command_identities:structuredClone(COMMAND_IDENTITIES),criteria: options.criteria ?? [], case_texts: options.caseTexts ?? ['健康检查间隔配置测试', 'widget health interval 60', QUOTE.text], item: options.item ?? 'doc-1:c-1', location: QUOTE.reference, data, contract: options.contractDoc ?? CONTRACT_DOC, profile: options.profileDoc ?? PROFILE_DOC, manifest: options.manifestDoc ?? MANIFEST_DOC, leases: options.leases ?? [], now: '2026-10-23T02:00:00.000Z' } }; }
/** The kityminder@1 model of the reviewed document: a tagged case and a marked-only case, each with a step and leaves. */
export const MINDMAP_MODEL = {
  meta: { id: 'doc-1' },
  nodes: [
    { text: '文档 doc-1', data: { id: 'doc-1' }, children: [1] },
    { text: '功能', data: { id: 'g-1', priority: 1 }, children: [2, 5] },
    { text: '健康检查间隔配置测试', data: { id: 'c-1', autoid: '990000000000000031', auto: '1', resource: ['功能'], priority: 2 }, children: [3], selector: 's/c-1' },
    { text: '配置健康检查间隔 widget health interval 60', data: { id: 'c-1-s1' }, children: [4], selector: 's/c-1-s1' },
    { text: '健康检查间隔设置成功', data: { id: 'c-1-e1' }, children: [], selector: 's/c-1-e1' },
    { text: '会话保持基本功能测试', data: { id: 'c-2', autoid: '990000000000000032', auto: '1', priority: 2 }, children: [6], selector: 's/c-2' },
    { text: '开启会话保持', data: { id: 'c-2-s1' }, children: [7], selector: 's/c-2-s1' },
    { text: '会话保持生效', data: { id: 'c-2-e1' }, children: [], selector: 's/c-2-e1' },
  ],
};

export const CATALOG_SPEC = {
  root: 'c'.repeat(64),
  complete: true,
  entries: [
    { head: 'widget health interval', signatures: [[{ name: 'seconds', type: 'int', minimum: 1, maximum: 300 }]], summary: 'set the health check interval' },
    { head: 'widget session persistence', signatures: [[{ name: 'mode', type: 'enum', values: ['source-address', 'cookie'] }]], summary: 'set the persistence mode' },
  ],
};
