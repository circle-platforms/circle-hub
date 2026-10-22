// Shared pager for reading complete results with hub_get_nodes across real client scenarios.
import type { Reply, Turn } from '../scripted-model.ts';

/** Maximum number of result pages to read with hub_get_nodes. */
export const MAX_PAGES = 6;

/**
 * Finds the first complete JSON object after "下一页：get_nodes " by counting curly braces,
 * parses it with JSON.parse, and extracts { reference, cursor }.
 * Returns null if the marker is not found or JSON has no reference/cursor.
 */
export function parseNextCall(text: string): { reference: string; cursor: string } | null {
  const marker = '下一页：get_nodes ';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;
  if (!/^\s*$/.test(text.slice(at + marker.length, start))) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          if (typeof parsed.reference === 'string' && typeof parsed.cursor === 'string') {
            return { reference: parsed.reference, cursor: parsed.cursor };
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

/** Extracts the 64-hex rec: reference from the start_run result text. */
export function parseRecReference(text: string): string | null {
  const match = /完整结果[^\n]*?\b(rec:[0-9a-fA-F]{64})\b/.exec(text);
  return match ? match[1] : null;
}

export interface PagerState {
  reference: string | null;
  pagesRead: number;
}

export function createPagerState(): PagerState {
  return { reference: null, pagesRead: 0 };
}

/**
 * Handles the common paging respond flow:
 * Turn 0: returns startAction();
 * Later turns: extracts rec: reference, calls hub_get_nodes, and pages using parseNextCall up to maxPages.
 */
export function pagedRespond(
  turn: Pick<Turn, 'index' | 'toolResults'>,
  state: PagerState,
  startAction: () => Reply,
  doneText = '完成。',
  maxPages = MAX_PAGES,
): Reply {
  if (turn.index === 0) {
    state.reference = null;
    state.pagesRead = 0;
    return startAction();
  }

  const lastText = turn.toolResults.map((r) => r.text).join('\n');
  if (state.reference === null) {
    state.reference = parseRecReference(lastText);
  }

  if (state.reference !== null && state.pagesRead === 0) {
    state.pagesRead = 1;
    return [{ tool: 'hub_get_nodes', input: { reference: state.reference } }];
  }

  if (state.pagesRead > 0 && state.pagesRead < maxPages) {
    const next = parseNextCall(lastText);
    if (next !== null) {
      state.pagesRead += 1;
      return [{ tool: 'hub_get_nodes', input: { reference: next.reference, cursor: next.cursor } }];
    }
  }

  return [{ text: doneText }];
}
