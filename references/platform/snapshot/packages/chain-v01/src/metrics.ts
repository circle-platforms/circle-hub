/**
 * The slice's declared metric lexicon. Extraction is a program
 * component (deterministic, auditable): each metric knows how it is
 * asked about and how its value appears in source text. Unrecognized
 * metrics yield no facts, which the chain reports as no-answer rather
 * than guessing — the lexicon's limits are part of the disclosure.
 */
export interface MetricDef {
  id: string;
  label: string;
  questionKeywords: string[];
  patterns: { re: RegExp; fixedValue?: string }[];
  normalize?: (raw: string) => string;
}

const digits = (raw: string) => raw.replace(/,/g, "");
const CN_NUM: Record<string, string> = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
  十: "10",
};
const cnOrDigits = (raw: string) => CN_NUM[raw] ?? digits(raw);

export const METRICS: MetricDef[] = [
  {
    id: "max-concurrent-connections",
    label: "最大并发连接数",
    questionKeywords: ["并发连接"],
    patterns: [{ re: /最大并发连接数\s*(\d[\d,]*)/ }],
    normalize: digits,
  },
  {
    id: "new-connections-per-second",
    label: "最大新建连接速率（CPS）",
    questionKeywords: ["新建连接速率", "CPS"],
    patterns: [
      { re: /新建连接速率[^。；]*?(\d[\d,]*)/ },
      { re: /CPS[^。；]*?(\d[\d,]*)/i },
    ],
    normalize: digits,
  },
  {
    id: "session-timeout-seconds",
    label: "会话超时默认（秒）",
    questionKeywords: ["会话超时"],
    patterns: [{ re: /会话超时默认\s*(\d+)\s*秒/ }],
    normalize: digits,
  },
  {
    id: "address-pool-size",
    label: "地址池规划（条）",
    questionKeywords: ["地址池"],
    patterns: [{ re: /地址池规划\s*(\d+)\s*条/ }],
    normalize: digits,
  },
  {
    id: "warranty-years",
    label: "保修年限（年）",
    questionKeywords: ["保修"],
    patterns: [{ re: /保修[^。；]*?([一二三四五六七八九十\d]+)\s*年/ }],
    normalize: cnOrDigits,
  },
  {
    id: "nat66-support",
    label: "是否支持 IPv6 NAT66",
    questionKeywords: ["NAT66"],
    patterns: [
      { re: /支持\s*IPv6\s*NAT66/, fixedValue: "supported" },
      { re: /(?:不支持|未支持)\s*(?:IPv6\s*)?NAT66/, fixedValue: "not-supported" },
    ],
  },
];

export function detectMetric(questionText: string): MetricDef | undefined {
  return METRICS.find((m) =>
    m.questionKeywords.some((k) => questionText.includes(k)),
  );
}

export interface ExtractedFact {
  metricId: string;
  value: string;
  quote: string;
}

/** Extract at most one value per metric from one source's content. */
export function extractFacts(content: string, metric: MetricDef): ExtractedFact[] {
  for (const pattern of metric.patterns) {
    const match = pattern.re.exec(content);
    if (match) {
      const raw = pattern.fixedValue ?? match[1] ?? "";
      const value = pattern.fixedValue
        ? pattern.fixedValue
        : metric.normalize
          ? metric.normalize(raw)
          : raw;
      const sentence =
        content
          .split(/[。；]/)
          .map((s) => s.trim())
          .find((s) => pattern.re.test(s) || s.includes(match[0])) ?? match[0];
      return [{ metricId: metric.id, value, quote: sentence }];
    }
  }
  return [];
}

/** Product named in the question text, when it names one (LBX-200 ...). */
export function detectQuestionProduct(questionText: string): string | undefined {
  return /LBX-\d+/.exec(questionText)?.[0];
}

/** Product a source speaks about: explicit field, else its first mention. */
export function sourceProduct(input: {
  product?: string;
  content: string;
}): string | undefined {
  return input.product ?? /LBX-\d+/.exec(input.content)?.[0];
}
