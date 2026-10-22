// The test-bed pack through the real client: the scripted model searches the beds of the named inventory document,
// acquires one bed, and then — when the gold asks for it — extends and releases the booking through the run lineage
// (every later run starts with its predecessor, the booking parameter names the booking run). The Hub's answers are
// compared with the answers written down independently in the gold file (the supervisor reads the real inventory
// document by hand: which beds fit the need and are free, which devices and addresses the acquire must name, for how
// long, and how long the extend adds).
//
// The lease keys never appear in the client-facing text (claims render their statement, not their data), so the gold
// holds the devices, addresses and hours the conclusions must name; the keys are mechanical from them
// (bed/<bed>/<device>, bed/<bed>/ip/<address>).
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { parseNextCall, parseRecReference } from './case-location.ts';

export interface SearchBedGold {
  /** The bed name as the manifest writes it. */
  name: string;
  /** 'idle' when the bed must get the exact idle qualifier; otherwise the ISO moment it must name as earliest free. */
  free: 'idle' | string;
}

export interface AcquireGold {
  bed: string;
  /** The device names the acquire conclusion must name (the picked devices, written down independently). */
  devices: string[];
  /** The addresses the conclusion must name, when addresses are requested. */
  addresses?: string[];
  /** Hours of the lease; defaults to need.hours, then 2. */
  hours?: number;
}

export interface ExtendGold {
  /** The hours the extend adds; the conclusion must say “延长 <hours> 小时”. */
  hours: number;
}

export interface TestBedGold {
  /** The named document holding the inventory manifest, without the doc:doc: prefix. */
  inventory: string;
  /** The need of both runs: device types and counts, and the hours when the acquire does not override them. */
  need: { devices: Array<{ type: string; count: number }>; hours?: number };
  /** Every bed the supervisor verified in the document, with the free wording it must get. */
  beds: SearchBedGold[];
  acquire: AcquireGold;
  /** Present when the scenario extends the booking after acquiring (same devices as the acquire). */
  extend?: ExtendGold;
  /** True when the scenario releases the booking at the end (after the extend when there is one). */
  release?: boolean;
}

/** The idle wording and the earliest-free wording, exactly as functions/match.ts writes them. */
export const IDLE_WORDING = 'Hub 记录里空闲（未排除本地操作）';
export const earliestWording = (moment: string): string => `Hub 记录里最早 ${moment} 空闲（未排除本地操作）`;

/** Maximum result pages to read per run with hub_get_nodes. */
export const MAX_PAGES = 4;

/** The run id of a start_run result text (“运行 run_<ulid> …”). */
export function parseRunId(text: string): string | null {
  const match = /\b(run_[0-9a-z]{26})\b/.exec(text);
  return match ? match[1] : null;
}

export default function scenario(gold: TestBedGold): Scenario {
  const area = '台架';
  const pack = 'test-bed';
  const hours = gold.acquire.hours ?? gold.need.hours ?? 2;
  const inputs = { inventory: { external: `doc:doc:${gold.inventory}` } };
  const need = { devices: gold.need.devices, hours };

  type Phase = 'search-rec' | 'search-pages' | 'acquire-rec' | 'acquire-pages' | 'extend-rec' | 'extend-pages' | 'release-rec' | 'release-pages' | 'done';
  let phase: Phase = 'search-rec';
  let reference: string | null = null;
  let pagesRead = 0;
  let booking: string | null = null;
  let lastRun: string | null = null;

  const getNodes = (input: { reference: string; cursor?: string }): { tool: string; input: unknown } => ({ tool: 'hub_get_nodes', input });
  const startRun = (parameters: Record<string, unknown>, predecessor?: string): { tool: string; input: unknown } => ({
    tool: 'hub_start_run',
    input: { pack, inputs, parameters, ...(predecessor !== undefined ? { predecessor } : {}) },
  });
  const readPages = (lastText: string, next: Phase): { tool: string; input: unknown }[] | null => {
    const rec = parseRecReference(lastText);
    if (rec !== null) {
      reference = rec;
      pagesRead = 1;
      phase = next;
      return [getNodes({ reference: rec })];
    }
    return null;
  };
  const pageOrMove = (lastText: string, move: () => { tool: string; input: unknown }[] | { text: string }[]): { tool: string; input: unknown }[] | { text: string }[] => {
    const next = parseNextCall(lastText);
    if (next !== null && pagesRead < MAX_PAGES) {
      pagesRead++;
      return [getNodes(next)];
    }
    return move();
  };

  return {
    name: 'test-bed',
    area,
    prompt: `请在台架清单 ${gold.inventory} 里搜索满足需求的台架，然后预订 ${gold.acquire.bed}，${hours} 小时${gold.extend !== undefined ? `，再续期 ${gold.extend.hours} 小时` : ''}${gold.release === true ? '，最后释放' : ''}。`,
    respond: (turn) => {
      const lastText = turn.toolResults.map((r) => r.text).join('\n');
      if (turn.index === 0) {
        phase = 'search-rec';
        return [startRun({ action: 'search', need })];
      }
      if (phase === 'search-rec') {
        const pages = readPages(lastText, 'search-pages');
        if (pages !== null) return pages;
        phase = 'done';
        return [{ text: '搜索没有给出完整结果的引用。' }];
      }
      if (phase === 'search-pages') {
        return pageOrMove(lastText, () => {
          phase = 'acquire-rec';
          return [startRun({ action: 'acquire', bed: gold.acquire.bed, need })];
        });
      }
      if (phase === 'acquire-rec') {
        booking = parseRunId(lastText);
        lastRun = booking;
        const pages = readPages(lastText, 'acquire-pages');
        if (pages !== null) return pages;
        phase = 'done';
        return [{ text: '预订没有给出完整结果的引用。' }];
      }
      if (phase === 'acquire-pages') {
        return pageOrMove(lastText, () => {
          if (gold.extend !== undefined && booking !== null) {
            phase = 'extend-rec';
            return [startRun({ action: 'extend', booking, hours: gold.extend.hours }, booking)];
          }
          if (gold.release === true && booking !== null && lastRun !== null) {
            phase = 'release-rec';
            return [startRun({ action: 'release', booking }, lastRun)];
          }
          phase = 'done';
          return [{ text: '搜索和预订完成。' }];
        });
      }
      if (phase === 'extend-rec') {
        lastRun = parseRunId(lastText) ?? lastRun;
        const pages = readPages(lastText, 'extend-pages');
        if (pages !== null) return pages;
        phase = 'done';
        return [{ text: '续期没有给出完整结果的引用。' }];
      }
      if (phase === 'extend-pages') {
        return pageOrMove(lastText, () => {
          if (gold.release === true && booking !== null && lastRun !== null) {
            phase = 'release-rec';
            return [startRun({ action: 'release', booking }, lastRun)];
          }
          phase = 'done';
          return [{ text: '续期完成。' }];
        });
      }
      if (phase === 'release-rec') {
        const pages = readPages(lastText, 'release-pages');
        if (pages !== null) return pages;
        phase = 'done';
        return [{ text: '释放没有给出完整结果的引用。' }];
      }
      if (phase === 'release-pages') {
        return pageOrMove(lastText, () => {
          phase = 'done';
          return [{ text: '释放完成。' }];
        });
      }
      return [{ text: '完成。' }];
    },
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const lines = text.split('\n');
      const runs = (text.match(/运行 run_/g) ?? []).length;
      const wantRuns = 2 + (gold.extend !== undefined ? 1 : 0) + (gold.release === true ? 1 : 0);
      const checks: Check[] = [
        { area, name: `${wantRuns} 次运行都拿到了结果，不是错误`, expected: `${wantRuns} 个“运行 run_…”，没有“出错”`, actual: `${runs} 个运行${text.includes('出错：') ? '，有出错' : ''}`, ok: runs >= wantRuns && !text.includes('出错：') },
      ];
      for (const bed of gold.beds) {
        const wording = bed.free === 'idle' ? IDLE_WORDING : earliestWording(bed.free);
        const found = lines.some((line) => line.includes(`台架 ${bed.name}`) && line.includes(wording));
        checks.push({
          area,
          name: `台架 ${bed.name} 的空闲结论与独立依据一致`,
          expected: `台架 ${bed.name}：…${wording}`,
          actual: found ? '一致' : (lines.find((line) => line.includes(`台架 ${bed.name}`)) ?? '没有这个台架的结论').slice(0, 160),
          ok: found,
        });
      }
      const acquireLine = lines.find((line) => line.includes(`预订 ${gold.acquire.bed}，`));
      checks.push({
        area,
        name: `预订 ${gold.acquire.bed} 的结论出现`,
        expected: `预订 ${gold.acquire.bed}，…，${hours} 小时`,
        actual: acquireLine !== undefined ? acquireLine.slice(0, 200) : '没有预订结论',
        ok: acquireLine !== undefined,
      });
      for (const device of gold.acquire.devices) {
        const found = acquireLine !== undefined && acquireLine.includes(device);
        checks.push({ area, name: `预订结论点名设备 ${device}`, expected: device, actual: found ? '点名' : '没有点名', ok: found });
      }
      for (const address of gold.acquire.addresses ?? []) {
        const found = acquireLine !== undefined && acquireLine.includes(address);
        checks.push({ area, name: `预订结论点名地址 ${address}`, expected: address, actual: found ? '点名' : '没有点名', ok: found });
      }
      const hoursFound = acquireLine !== undefined && acquireLine.includes(`${hours} 小时`);
      checks.push({ area, name: `预订结论的时长是 ${hours} 小时`, expected: `${hours} 小时`, actual: hoursFound ? `${hours} 小时` : '不一致', ok: hoursFound });
      if (gold.extend !== undefined) {
        const extendLine = lines.find((line) => line.includes(`续期 ${gold.acquire.bed} 的预订`));
        const hoursOk = extendLine !== undefined && extendLine.includes(`延长 ${gold.extend.hours} 小时`);
        const devicesOk = gold.acquire.devices.every((device) => extendLine !== undefined && extendLine.includes(device));
        checks.push({
          area,
          name: `续期结论点名预订、设备和延长 ${gold.extend.hours} 小时`,
          expected: `续期 ${gold.acquire.bed} 的预订 run_…，…，延长 ${gold.extend.hours} 小时`,
          actual: extendLine !== undefined ? extendLine.slice(0, 200) : '没有续期结论',
          ok: extendLine !== undefined && hoursOk && devicesOk,
        });
      }
      if (gold.release === true) {
        const releaseLine = lines.find((line) => line.includes(`释放 ${gold.acquire.bed} 的预订`));
        const devicesOk = gold.acquire.devices.every((device) => releaseLine !== undefined && releaseLine.includes(device));
        checks.push({
          area,
          name: `释放结论点名预订和设备`,
          expected: `释放 ${gold.acquire.bed} 的预订 run_…，…`,
          actual: releaseLine !== undefined ? releaseLine.slice(0, 200) : '没有释放结论',
          ok: releaseLine !== undefined && devicesOk,
        });
      }
      checks.push({ area, name: '回答没有超过客户端能转交的长度', expected: '每个工具结果不超过 30000 个字符', actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`, ok: resultTexts(turns).every((t) => t.length <= 30_000) });
      return checks;
    },
  };
}
