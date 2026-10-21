// One real call each of a yes/no and a single-choice question to the typed-judgment service, with invented content, to prove the
// HttpJev client against the real API. The key is read from the owner's environment file at run time and never printed.
//   node scripts/real/jev-smoke.ts --env-file <file> [--model jev-1.13.0] [--key-name TYPESAFE_API_KEY]
import { HttpJev, NONE_OPTION, topChoice } from '../../hub/jev/api.ts';
import { pick, readEnvFile } from './lib/env-file.ts';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

export async function main(): Promise<number> {
  const keyName = arg('key-name', 'TYPESAFE_API_KEY');
  const entry = pick(readEnvFile(arg('env-file')), keyName);
  if (!entry) {
    console.log(`${keyName}: 未找到`);
    return 1;
  }
  console.log(`${keyName}: 已找到，长度 ${entry.value.length}`);
  const jev = new HttpJev({ apiKey: () => entry.value, model: arg('model', 'jev-1.13.0') });
  const response = await jev.ask({
    model: jev.pinnedModel,
    state: { s1: '命令 show version 用来显示设备的软件版本。', s2: '配置 SSL 虚拟主机时需要先导入证书。' },
    questions: {
      yes_no: { type: 'noul', instructions: '`s1` 讲的是显示信息而不是修改配置吗？', criteria: { true: '是显示信息', false: '会修改配置' } },
      chapter: {
        type: 'choice',
        instructions: '`s2` 属于手册的哪一章？',
        criteria: { 系统管理: '设备本身的管理', SSL: '证书与加密配置', 网络: '接口和路由', [NONE_OPTION]: '以上都不是' },
      },
    },
  });
  const yes = response.answers.yes_no;
  const chapter = response.answers.chapter;
  console.log(`模型：${response.model}，请求号：${response.requestId ?? '无'}，令牌：输入 ${response.usage.inputTokens}，输出 ${response.usage.outputTokens}`);
  if (yes?.type === 'noul') console.log(`是否题：为是的概率 ${yes.noul.toFixed(3)}`);
  if (chapter?.type === 'choice') {
    const top = topChoice(chapter);
    console.log(`单选题：${top.choice}，概率 ${top.p.toFixed(3)}，间隔 ${top.margin.toFixed(3)}，置信度 ${chapter.confidence.toFixed(3)}，概率 ${JSON.stringify(Object.fromEntries(Object.entries(chapter.probabilities).map(([k, v]) => [k, Number(v.toFixed(3))])))}`);
  }
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: Error) => {
      console.log(`失败：${error.name}：${error.message.slice(0, 200)}`);
      process.exitCode = 1;
    },
  );
}
