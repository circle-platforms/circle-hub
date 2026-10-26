import {createHash} from 'node:crypto';
import {STRUCTURAL_CATALOG_SPEC,nativeStep,nativeExpected,indexedStructure} from './structure.ts';
// Synthetic fixtures for defect-to-case workflow tests.
import type { CatalogEntry } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import { buildCatalog, type CatalogSpec } from '../../../../hub/rules/api.ts';
import type { DraftCase } from '../functions/types.ts';

const ROOT_DIGEST = 'a'.repeat(64);

export const SYNTHETIC_BUG_74001 = {
  id: '74001', kind: 'bug', title: 'SLB健康检查间隔无法保存', fix_field: 'fix',
  fields: {
    id: '74001', title: 'SLB健康检查间隔无法保存', status: 'closed', resolution: 'fixed', severity: 'major', assignedTo: 'synthetic-tester',
    steps: '进入合成页面，修改间隔后保存',
    fix: '修复说明：修复参数范围校验，修复保存后不生效的问题。命令行配置 widget health interval <1-300>。期望结果：健康检查间隔设置成功，系统运行正常。',
  },
  html_fields: ['steps', 'fix'],
};

export const SYNTHETIC_BUG_71010_UNCHECKABLE = {
  id: '71010', kind: 'bug', title: '底层组件内存碎片整理优化', fix_field: 'fix',
  fields: { id: '71010', title: '底层组件内存碎片整理优化', status: 'closed', resolution: 'fixed', steps: '内部优化任务', fix: '代码内部重构与碎片整理，无外部可测命令行或行为变化。' },
  html_fields: ['steps', 'fix'],
};

export const MANUAL_PASSAGE = '配置命令行 service http port <1-65535>。期望结果：服务端口修改成功，HTTP服务正常监听。';

export const SYNTHETIC_CATALOG_SPEC:CatalogSpec=STRUCTURAL_CATALOG_SPEC;

export const SYNTHETIC_CATALOG: CatalogEntry[] = buildCatalog(SYNTHETIC_CATALOG_SPEC).entries();

export const SYNTHETIC_INDEX_VIEW: IndexView = {
  schema: 'index-view@1',
  product: 'famx',
  build: { build: 'Rel_FAMX_10_6_1_57', root: '1111111111111111111111111111111111111111111111111111111111111111' },
  kind: 'case',
  key: 'commands',
  keys: {
    '/commands/show/health/detail': ['2222222222222222222222222222222222222222222222222222222222222222'],
  },
  entries: {
    '2222222222222222222222222222222222222222222222222222222222222222': {
      entry: '2222222222222222222222222222222222222222222222222222222222222222',
      kind: 'case',
      statement: 'doc_101:node_5 | 健康检查详细信息查看',
      reference: `tree:${'1'.repeat(64)}/commands/show/health/detail@${'2'.repeat(64)}`,
      data: {
        case_structure:structuredClone(indexedStructure),
        document: 'doc_101',
        node: 'node_5',
        title: '健康检查详细信息查看',
        negative: false,
        commands: ['/commands/show/health/detail'],
        expected_texts: ['健康检查状态显示正常'],
      },
    },
  },
  total_keys: 1,
  total_entries: 1,
  truncated: false,
  skipped: 0,
  notes: [],
};

/** The same view without the narrowing echo: the complete-index rule applies (old behaviour). */
export const SYNTHETIC_INDEX_VIEW_COMPLETE: IndexView = {
  ...SYNTHETIC_INDEX_VIEW,
  notes: [],
};

export const INCOMPLETE_INDEX_VIEW: IndexView = {
  ...SYNTHETIC_INDEX_VIEW,
  skipped: 3,
  notes: ['3 listed sources went unused'],
};

export const BUG_RAW=JSON.stringify(SYNTHETIC_BUG_74001);
export const BUG_SHA=createHash('sha256').update(BUG_RAW).digest('hex');
export const FIX_REF='src:'+BUG_SHA+'/json@1/p/fields/fix';
export function expectedFor(text:string,ref?:string){const fallback=nativeExpected(text);if(ref===FIX_REF&&BUG_RAW.includes(fallback.quote.text)){const quote=fallback.quote.text,at=BUG_RAW.indexOf(quote);return {...fallback,identity:{source_sha256:BUG_SHA,parser:'json@1',path:'p/fields/fix',span:{unit:'byte' as const,offset:Buffer.byteLength(BUG_RAW.slice(0,at)),length:Buffer.byteLength(quote)}},quote:{reference:ref,text:quote}};}return {...fallback,quote:{...fallback.quote,...(ref?{reference:ref}:{})}};}
export function makeGoodDraft(options:{ref?:string}={}):DraftCase{return {id:'draft-good',title:'SLB健康检查间隔配置正向测试',priority:2,negative:false,expects_refutation:false,preconditions:['SLB服务正常运行'],steps:[nativeStep('widget health interval 60')],expected:[expectedFor('健康检查间隔设置成功',options.ref)],tags:['functional'],resource:['functional']};}
export const goodDraft=(overrides:Partial<DraftCase>={}):DraftCase=>({...makeGoodDraft(),...(overrides.negative===true?{resource:['negative'],tags:['negative']}:{}),...overrides});
export function makeNegativeExpectedRefutationDraft(options:{ref?:string}={}):DraftCase{return goodDraft({id:'draft-negative',title:'SLB健康检查间隔超界反向测试',negative:true,expects_refutation:true,steps:[{command:'widget health interval 99999'}],expected:[expectedFor('系统运行正常',options.ref)]});}
export function makeNegativeUnexpectedAcceptDraft(options:{ref?:string}={}):DraftCase{return goodDraft({id:'draft-negative-valid',negative:true,expects_refutation:true,expected:[expectedFor('系统运行正常',options.ref)]});}
export function makeDuplicateDraft(options:{ref?:string}={}):DraftCase{return goodDraft({id:'draft-duplicate',title:'健康检查详细信息查看',steps:[nativeStep('show health detail')],expected:[expectedFor('健康检查状态显示正常',options.ref)]});}

/** A version-line manual bound before projection, matching the real input contract. */
export const SYNTHETIC_BOUND_MANUAL = {
  slot: 'manual', external: 'manual:cli:10.6.1', sha256: 'c'.repeat(64),
  media_type: 'text/markdown', parser: 'markdown@1', model: {}, meta: null,
};
