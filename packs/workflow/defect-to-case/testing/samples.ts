import {nativeStep,nativeExpected,EXPECTED_IDENTITY,STRUCTURAL_CATALOG_SPEC} from './structure.ts';
// Sample generator for defect-to-case pack (pack-sample@1).
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackSample } from '../../../../contracts/src/pack.ts';
import { commandSubject, duplicateSubject, quoteSubject } from '../functions/subjects.ts';
import { SYNTHETIC_BUG_74001, SYNTHETIC_CATALOG_SPEC, SYNTHETIC_INDEX_VIEW, goodDraft } from './fixtures.ts';

const BUG_ID = SYNTHETIC_BUG_74001.id;
const BUG_DIGEST = createHash('sha256').update(JSON.stringify(SYNTHETIC_BUG_74001)).digest('hex');
const FIX_REF = `src:${BUG_DIGEST}/json@1/p/fields/${SYNTHETIC_BUG_74001.fix_field}`;
const FIX_TEXT = SYNTHETIC_BUG_74001.fields.fix;

type Entry = { folder: 'positive' | 'negative'; sample: PackSample };

function sample(
  folder: Entry['folder'],
  id: string,
  check: string,
  note: string,
  subject: unknown,
  expect: PackSample['expect'],
  extra: Partial<PackSample> = {},
): Entry {
  return { folder, sample: { id, source: 'author', check, note, subject, ...extra, expect } };
}

export function samples(): Entry[] {
  const defaultGoodSubject = {
    item: BUG_ID,
    label: SYNTHETIC_BUG_74001.title,
    location: `src:${BUG_DIGEST}/json@1/p/id`,
    fields: SYNTHETIC_BUG_74001.fields,
    slots: {
      cases: [
        {
          text: '健康检查间隔设置回归测试',
          data: goodDraft({
            title: '配置健康检查间隔为 60 秒',
            steps: [{ text: '执行配置命令', command: 'widget health interval 60' }],
            expected: [
              {
                text: '健康检查间隔设置成功',
                quote: { reference: FIX_REF, text: '健康检查间隔设置成功' },
                after:1,identity:{source_sha256:BUG_DIGEST,parser:'json@1',path:'p/fields/fix',span:{unit:'byte',offset:Buffer.byteLength(JSON.stringify(SYNTHETIC_BUG_74001).slice(0,JSON.stringify(SYNTHETIC_BUG_74001).indexOf('健康检查间隔设置成功'))),length:Buffer.byteLength('健康检查间隔设置成功')}},
              },
            ],
          }),
        },
      ],
    },
    evidence: [],
  };

  const defaultBadShapeSubject = {
    item: BUG_ID,
    slots: {
      cases: [
        {
          text: '',
          data: goodDraft({
            title: '', // Invalid empty title
          }),
        },
      ],
    },
  };

  const defaultRefutationPositiveSubject = {
    item: BUG_ID,
    slots: {
      cases: [
        {
          text: '反向测试：健康检查间隔超出范围反驳',
          data: goodDraft({
            title: '健康检查间隔超出范围反驳',
            negative: true,
            expects_refutation: true,
            steps: [{ text: '设置超出范围的间隔', command: 'widget health interval 999' }],
            expected: [
              {
                text: '提示取值超出范围',
                quote: { reference: FIX_REF, text: '健康检查间隔设置成功' },
              },
            ],
          }),
        },
      ],
    },
  };

  const defaultRefutationNegativeSubject = {
    item: BUG_ID,
    slots: {
      cases: [
        {
          text: '反向测试错误声明：预期反驳但命令合法',
          data: goodDraft({
            title: '健康检查间隔设置',
            negative: true,
            expects_refutation: true,
            steps: [{ text: '设置合法间隔', command: 'widget health interval 60' }],
            expected: [
              {
                text: '健康检查间隔设置成功',
                quote: { reference: FIX_REF, text: '健康检查间隔设置成功' },
              },
            ],
          }),
        },
      ],
    },
  };

  const defaultReadingBadSubject = {
    item: BUG_ID,
    slots: {
      cases: [
        {
          text: '阅读引入未载实体',
          data: goodDraft({
            title: '健康检查配置测试',
            expected: [
              {
                text: '健康检查间隔设置成功且端口为 8080', // 8080 not in quote
                quote: { reference: FIX_REF, text: '健康检查间隔设置成功' },
              },
            ],
          }),
        },
      ],
    },
  };

  return [
    sample('positive','fixed_status_declared','fixed_status','原始结构状态明确 fixed',{item:BUG_ID,fields:{fixed_status:{declaration_status:'declared',status:'fixed'}}},[{verdict:'support',item:BUG_ID,tier:'advisory'}]),
    sample('negative','fixed_status_known','fixed_status','known 不能支持已修复',{item:BUG_ID,fields:{fixed_status:{declaration_status:'declared',status:'known'}}},[{verdict:'refute',code:'defect-to-case.not_fixed',item:BUG_ID,tier:'advisory'}]),
    // 1. draft_shape
    sample(
      'positive',
      'shape_clean',
      'draft_shape',
      '起草用例结构完整、字段合法',
      defaultGoodSubject,
      [{ verdict: 'support', item: BUG_ID }],
    ),
    sample(
      'negative',
      'shape_invalid',
      'draft_shape',
      '起草用例缺少标题、步骤和期望结果且优先级越界',
      defaultBadShapeSubject,
      [{ verdict: 'refute', code: 'defect-to-case.shape_invalid', item: BUG_ID, tier: 'blocking' }],
    ),

    // 2. commands_catalog
    sample(
      'positive',
      'commands_valid',
      'commands_catalog',
      '用例步骤中的命令在目录中存在且参数类型和范围合法',
      commandSubject(defaultGoodSubject),
      [{ verdict: 'support', item: BUG_ID }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),
    sample(
      'negative',
      'commands_out_of_range',
      'commands_catalog',
      '普通正向用例步骤中的命令参数超出目录定义的取值范围',
      {
        item: BUG_ID,
        location: null,
        phrases: ['widget health interval 999'],
        negative: false,
      },
      [{ verdict: 'refute', code: 'core.catalog.param_out_of_range', item: BUG_ID, tier: 'blocking' }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),

    // 3. commands_refutation
    sample(
      'positive',
      'refutation_valid',
      'commands_refutation',
      '反向用例声明预期被反驳且命令确实被目录反驳',
      defaultRefutationPositiveSubject,
      [{ verdict: 'support', item: BUG_ID }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),
    sample(
      'negative',
      'negative_accepted',
      'commands_refutation',
      '反向用例声明预期被反驳但命令被目录接受',
      {...defaultRefutationNegativeSubject,slots:{cases:[{data:goodDraft({resource:['functional'],negative:false,expects_refutation:true})}]}},
      [{ verdict: 'refute', code: 'defect-to-case.shape_invalid', item: BUG_ID, tier: 'blocking' }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),

    // 4. grounded_quotes
    sample(
      'positive',
      'quotes_verbatim',
      'grounded_quotes',
      '期望结果逐字引文完全存在于所引来源中',
      quoteSubject(defaultGoodSubject),
      [{ verdict: 'support', item: BUG_ID }],
      { sources: { [FIX_REF]: FIX_TEXT } },
    ),
    sample(
      'negative',
      'quotes_mismatch',
      'grounded_quotes',
      '期望结果引文与来源文本不符',
      {
        item: BUG_ID,
        quotes: [{ reference: FIX_REF, text: '故意捏造的不存在引文' }],
      },
      [{ verdict: 'refute', code: 'QUOTE_MISMATCH', item: BUG_ID, tier: 'blocking' }],
      { sources: { [FIX_REF]: FIX_TEXT } },
    ),

    sample('positive', 'sources_allowed', 'grounded_sources', '只引用本条缺陷的配置修复字段', {
      item: BUG_ID, allowed_quote_sources: { defect: 'b'.repeat(64), manual: 'c'.repeat(64), fix_field: 'fix' },
      quotes: [{ reference: `src:${'b'.repeat(64)}/json@1/p/fields/fix`, text: '合成修复说明' }],
    }, [{ verdict: 'support', item: BUG_ID, tier: 'blocking' }]),
    sample('negative', 'sources_forbidden', 'grounded_sources', '缺陷步骤字段不是修复说明', {
      item: BUG_ID, allowed_quote_sources: { defect: 'b'.repeat(64), manual: 'c'.repeat(64), fix_field: 'fix' },
      quotes: [{ reference: `src:${'b'.repeat(64)}/json@1/p/fields/steps`, text: '合成步骤' }],
    }, [{ verdict: 'refute', code: 'defect-to-case.quote_source_forbidden', item: BUG_ID, tier: 'blocking' }]),

    // 5. grounded_reading
    sample(
      'positive',
      'reading_grounded',
      'grounded_reading',
      '期望文字为自身引文的逐字片段',
      defaultGoodSubject,
      [{ verdict: 'support', item: BUG_ID }],
      {sources:{['src:'+BUG_DIGEST]:JSON.stringify(SYNTHETIC_BUG_74001)}},
    ),
    sample(
      'negative',
      'reading_unsupported_entity',
      'grounded_reading',
      '期望文字不是自身引文的逐字片段',
      defaultReadingBadSubject,
      [{ verdict: 'refute', code: 'defect-to-case.expect_not_in_quote', item: BUG_ID, tier: 'blocking' }],
      {sources:{['src:'+BUG_DIGEST]:JSON.stringify(SYNTHETIC_BUG_74001)}},
    ),

    sample('positive','refutation_expected','refutation_catalog','完整签名确认无效参数符合显式反向主张',{item:BUG_ID,claims:[{command:'widget health interval 999',present:false}]},[{verdict:'support',item:BUG_ID}],{catalog:STRUCTURAL_CATALOG_SPEC}),
    sample('negative','refutation_contradicted','refutation_catalog','有效签名反驳不存在的主张',{item:BUG_ID,claims:[{command:'widget health interval 60',present:false}]},[{verdict:'refute',code:'core.catalog.membership_contradicted',item:BUG_ID}],{catalog:STRUCTURAL_CATALOG_SPEC}),
    // 6. duplicate_check
    sample(
      'positive',
      'duplicate_none',
      'duplicate_check',
      '起草用例在已有索引中无重复项',
      {
        item: BUG_ID,
        drafts: [
          goodDraft({
            title: '查看健康检查状态',
            steps: [nativeStep('show health')],
            expected: [nativeExpected('显示健康')],
          }),
        ],
        indexed_cases: SYNTHETIC_INDEX_VIEW,
      },
      [{ verdict: 'support', item: BUG_ID }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),
    sample(
      'negative',
      'duplicate_found',
      'duplicate_check',
      '标题不同，但完整命令参数和期望引文身份相同，按结构反驳',
      {
        item: BUG_ID,
        drafts: [
          goodDraft({
            title: '标题不同仍是同一结构',
            steps: [nativeStep('show health detail')],
            expected: [nativeExpected()],
          }),
        ],
        indexed_cases: SYNTHETIC_INDEX_VIEW,
      },
      [{ verdict: 'refute', code: 'defect-to-case.duplicate_case', item: BUG_ID, tier: 'advisory' }],
      { catalog: SYNTHETIC_CATALOG_SPEC },
    ),
  ];
}

export function sampleText(entry: Entry): string {
  return `${JSON.stringify(entry.sample, null, 2)}\n`;
}

export const SAMPLES_DIR = fileURLToPath(new URL('../samples/', import.meta.url));

export async function writeSamples(dir: string = SAMPLES_DIR): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const entry of samples()) {
    const folder = join(dir, entry.folder);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${entry.sample.id}.json`), sampleText(entry));
    written.push(`${entry.folder}/${entry.sample.id}.json`);
  }
  return written;
}

export async function listSamples(dir: string = SAMPLES_DIR): Promise<string[]> {
  const out: string[] = [];
  for (const folder of ['negative', 'positive']) {
    try {
      for (const name of (await readdir(join(dir, folder))).sort()) out.push(`${folder}/${name}`);
    } catch {
      // folder missing
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  console.log((await writeSamples()).join('\n'));
}
