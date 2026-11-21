import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_ID_PREFIXES,
  APPROVED_PUBLIC_RUN_ID,
  DEFAULT_EXCEPTIONS_PATH,
  addressAndIdProblems,
  collectLiteralsInText,
  evaluateAddressAndIds,
  isAutoAllowedId,
  isAutoAllowedIpv4,
  isDocsPath,
  isIdArtifactPath,
  parseExceptionList,
} from './address-id-check.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const quad = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');
const makeId = (prefix: string, body: string): string => `${prefix}_${body}`;
const sampleId = (prefix: string, tag = '01'): string => makeId(prefix, tag + 'a'.repeat(26 - tag.length));
const zeroId = (prefix: string): string => makeId(prefix, '0'.repeat(26));

function withTempGitRepo(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'address-id-check-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(dir, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf8');
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('auto-allow predicates and scopes', () => {
  it('allows only RFC 5737 documentation ranges and loopback IPv4 ranges', () => {
    for (const ok of [
      '192.0.2.0',
      '192.0.2.1',
      '192.0.2.255',
      '198.51.100.1',
      '203.0.113.42',
      '127.0.0.0',
      '127.0.0.1',
      '127.10.20.30',
    ]) {
      assert.equal(isAutoAllowedIpv4(ok), true, ok);
    }

    for (const restricted of [
      quad(0, 0, 0, 0),
      quad(10, 6, 1, 57),
      quad(172, 16, 35, 70),
      quad(192, 168, 1, 10),
      quad(192, 0, 3, 1),
      quad(198, 18, 0, 1),
      quad(198, 51, 101, 1),
      quad(203, 0, 114, 1),
      quad(255, 255, 255, 0),
      quad(4, 1, 2, 1),
      '256.0.0.1',
      '01.0.0.1',
    ]) {
      assert.equal(isAutoAllowedIpv4(restricted), false, restricted);
    }
  });

  it('auto-allows all-zero IDs for every prefix and the approved public run example', () => {
    assert.equal(isAutoAllowedId(APPROVED_PUBLIC_RUN_ID), true);
    for (const prefix of ALLOWED_ID_PREFIXES) {
      assert.equal(isAutoAllowedId(zeroId(prefix)), true, prefix);
      assert.equal(isAutoAllowedId(sampleId(prefix)), false, prefix);
    }
  });

  it('matches docs/ and non-test artifact scopes accurately', () => {
    assert.equal(isDocsPath('docs/index.md'), true);
    assert.equal(isDocsPath('packs/workflow/case-compile/SKILL.md'), false);

    assert.equal(isIdArtifactPath('packs/workflow/case-compile/SKILL.md'), true);
    assert.equal(isIdArtifactPath('packs/workflow/case-review/examples/submit-result.json'), true);
    assert.equal(isIdArtifactPath('scripts/real/probe.ts'), true);
    assert.equal(isIdArtifactPath('tools/gen.ts'), true);

    assert.equal(isIdArtifactPath('packs/workflow/case-compile/functions/checks.test.ts'), false);
    assert.equal(isIdArtifactPath('packs/workflow/case-compile/testing/samples.ts'), false);
    assert.equal(isIdArtifactPath('scripts/real/testing-real.ts'), false);
    assert.equal(isIdArtifactPath('tools/helper/testing/fixture.json'), false);
    assert.equal(isIdArtifactPath('contracts/src/fixtures.ts'), false);
    assert.equal(isIdArtifactPath('hub/server/run-export.ts'), false);
  });
});

describe('literal collection in text', () => {
  it('captures dotted-quad IPv4 literals regardless of surrounding context and tracks exact line numbers', () => {
    const versionLike = quad(10, 6, 1, 57);
    const deviceLike = quad(172, 16, 35, 70);
    const source = [
      'host 192.0.2.10 and loopback 127.0.0.1',
      `v${versionLike} in release text and oid 2.5.29.14.1 (five parts skipped)`,
      `bad octet 1.2.3.256 ignored; URL http://${deviceLike}:8080/api and Tag.${deviceLike}.end flagged`,
    ].join('\n');

    const hits = collectLiteralsInText('packs/workflow/sample/SKILL.md', source);
    assert.deepEqual(
      hits.map((h) => ({ line: h.line, literal: h.literal, scope: h.scope })),
      [
        { line: 2, literal: versionLike, scope: 'ipv4' },
        { line: 3, literal: deviceLike, scope: 'ipv4' },
        { line: 3, literal: deviceLike, scope: 'ipv4' },
      ],
    );
  });

  it('rejects every 26-char ID prefix under docs/ including all-zero and the public example', () => {
    const lines = [
      `zero=${zeroId('run')}`,
      `public=${APPROVED_PUBLIC_RUN_ID}`,
      ...ALLOWED_ID_PREFIXES.map((p) => sampleId(p, '01')),
    ];
    const hits = collectLiteralsInText('docs/guide.md', lines.join('\n'));
    assert.equal(hits.length, 2 + ALLOWED_ID_PREFIXES.length);
    assert.ok(hits.every((h) => h.scope === 'docs-id'));
  });

  it('permits only all-zero and public example IDs in non-test pack/script/tool files, while leaving test files exempt from ID checks', () => {
    const privateId = sampleId('rec', '01ab');
    const source = [zeroId('usr'), APPROVED_PUBLIC_RUN_ID, privateId].join('\n');

    const artifactHits = collectLiteralsInText('scripts/real/probe.ts', source);
    assert.deepEqual(
      artifactHits.map((h) => ({ line: h.line, literal: h.literal, scope: h.scope })),
      [{ line: 3, literal: privateId, scope: 'artifact-id' }],
    );

    assert.deepEqual(collectLiteralsInText('scripts/real/probe.test.ts', source), []);
    assert.deepEqual(collectLiteralsInText('packs/workflow/x/testing/helper.ts', source), []);
  });
});

describe('exception manifest parsing and bidirectional evaluation', () => {
  it('validates TSV columns, canonical paths, categories, auto-allow exclusions, docs ID bans, and duplicates', () => {
    const testIp = quad(172, 16, 1, 9);
    const badId = sampleId('run', '01zzzz');
    const manifest = [
      '# comment line',
      'bad-columns-only',
      `./rel/path.ts\t${testIp}\t私网定义表、掩码与测试字面量\tbad rel path`,
      `hub/a.ts\t192.0.2.5\t私网定义表、掩码与测试字面量\tauto allowed doc net`,
      `docs/a.md\t${badId}\t已发布示例编号\t待随下次升版替换`,
      `packs/a/b.test.ts\t${badId}\t已发布示例编号\t待随下次升版替换`,
      `packs/a/b.json\t${badId}\t已发布示例编号\tmissing required marker`,
      `packs/a/b.json\t${testIp}\t未知分类\tnote`,
      `packs/a/b.json\t${badId}\t已发布示例编号\t待随下次升版替换`,
      `packs/a/b.json\t${badId}\t已发布示例编号\t待随下次升版替换`,
    ].join('\n');

    const parsed = parseExceptionList(manifest);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.errors.length, 8);
    assert.match(parsed.errors[0]!, /共 4 列/);
    assert.match(parsed.errors[1]!, /无效仓库相对路径/);
    assert.match(parsed.errors[2]!, /不应放进例外清单/);
    assert.match(parsed.errors[3]!, /docs\/ 下不允许/);
    assert.match(parsed.errors[4]!, /不在非测试制品编号检查范围内/);
    assert.match(parsed.errors[5]!, /待随下次升版替换/);
    assert.match(parsed.errors[6]!, /不受支持/);
    assert.match(parsed.errors[7]!, /重复例外条目/);
  });

  it('reports unregistered IPv4 and ID hits with path, line, literal, and remediation guidance, and fails on stale exceptions', () => {
    const versionIp = quad(10, 6, 1, 57);
    const registeredIp = quad(10, 6, 2, 31);
    const missingIp = quad(10, 9, 9, 9);
    const pubOldId = sampleId('run', '01oldold');
    const newBadId = sampleId('tok', '01badtok');

    const manifest = [
      `packs/a/file.ts\t${registeredIp}\t合成产品版本号\tkeep`,
      `packs/a/gone.ts\t${missingIp}\t合成产品版本号\tto delete`,
      `packs/a/SKILL.md\t${pubOldId}\t已发布示例编号\t待随下次升版替换`,
    ].join('\n');
    const parsed = parseExceptionList(manifest);
    assert.deepEqual(parsed.errors, []);

    const problems = evaluateAddressAndIds(
      [
        { path: 'packs/a/file.ts', text: `line 1\nversion=${registeredIp}\nunlisted=${versionIp}` },
        { path: 'packs/a/SKILL.md', text: `allowed=${pubOldId}\n${newBadId}` },
        { path: 'docs/page.md', text: `oops ${sampleId('exe', '01leakid')}` },
      ],
      parsed,
    );

    assert.equal(problems.length, 4);
    assert.match(problems[0]!, new RegExp(`packs/a/file\\.ts:3:.*${versionIp.replaceAll('.', '\\.')}.*换成文档专用网段`));
    assert.match(problems[1]!, new RegExp(`packs/a/SKILL\\.md:2:.*${newBadId}.*换成全 0 占位编号`));
    assert.match(problems[2]!, /docs\/page\.md:1:.*docs\/ 不设例外/);
    assert.match(problems[3]!, new RegExp(`\\.github/checks/address-id-exceptions\\.tsv:2: 例外已失效.*${missingIp.replaceAll('.', '\\.')}.*只减不增`));
  });
});

describe('temporary git repository integration', () => {
  it('fails when the exception manifest is missing and enforces full check on git-tracked files', () => {
    withTempGitRepo({ 'docs/a.md': 'ok 192.0.2.1' }, (dir) => {
      const problems = addressAndIdProblems(dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /^missing exceptions manifest:/);
    });

    const exemptIp = quad(198, 18, 0, 1);
    const unexemptIp = quad(172, 16, 35, 70);
    const exemptId = sampleId('run', '01m5test');
    withTempGitRepo(
      {
        [DEFAULT_EXCEPTIONS_PATH]: [
          `hub/config.ts\t${exemptIp}\t私网定义表、掩码与测试字面量\tbench`,
          `packs/p/SKILL.md\t${exemptId}\t已发布示例编号\t待随下次升版替换`,
        ].join('\n'),
        'hub/config.ts': `const h = '${exemptIp}';\n`,
        'packs/p/SKILL.md': `id: ${exemptId}\n`,
        'docs/intro.md': 'doc uses 198.51.100.7 and 127.0.0.1\n',
      },
      (dir) => {
        assert.deepEqual(addressAndIdProblems(dir), []);

        writeFileSync(join(dir, 'packs/p/SKILL.md'), `id: ${exemptId}\nbad: ${unexemptIp}\n`, 'utf8');
        const addedHit = addressAndIdProblems(dir);
        assert.equal(addedHit.length, 1);
        assert.match(addedHit[0]!, /packs\/p\/SKILL\.md:2:/);

        writeFileSync(join(dir, 'packs/p/SKILL.md'), 'clean 203.0.113.5\n', 'utf8');
        const stale = addressAndIdProblems(dir);
        assert.equal(stale.length, 1);
        assert.match(stale[0]!, /例外已失效/);

        writeFileSync(join(dir, 'packs/p/nul.md'), `ok\0${unexemptIp}\0end\n`, 'utf8');
        symlinkSync(`target-${unexemptIp}.txt`, join(dir, 'docs/dangling-link'));
        execFileSync('git', ['add', 'packs/p/nul.md', 'docs/dangling-link'], { cwd: dir });
        const rawHits = addressAndIdProblems(dir);
        assert.ok(rawHits.some((p) => p.includes('packs/p/nul.md:1:')));
        assert.ok(rawHits.some((p) => p.includes('docs/dangling-link:1:')));
      },
    );
  });
});

describe('repository compliance', () => {
  it('all tracked files satisfy IPv4 and internal ID rules against the monotonically shrinking exception list', () => {
    assert.deepEqual(addressAndIdProblems(ROOT), []);
    const parsed = parseExceptionList(readFileSync(join(ROOT, DEFAULT_EXCEPTIONS_PATH), 'utf8'));
    assert.deepEqual(parsed.errors, []);
    const publishedIdEntries = parsed.entries.filter((e) => e.category === '已发布示例编号');
    assert.ok(publishedIdEntries.every((e) => e.note.includes('待随下次升版替换')));
  });
});
