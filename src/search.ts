// The agent's one tool: web search.
//
// Design choices:
// - One call takes up to 4 queries and runs them in parallel. Comparing five
//   CRM vendors is one round trip, not five model turns.
// - `full_pages` swaps snippets for page text. Pricing tables rarely survive
//   into a snippet, and this keeps "read the page" inside the single tool.
// - A per-answer SourceRegistry gives every URL a stable number, so citations
//   like [3] mean the same thing across several searches in one answer.
// - A short TTL cache makes follow-up questions on the same topic instant.

import type { Source } from './db.js';

export interface SearchArgs {
  queries: string[];
  recency?: 'day' | 'week' | 'month' | 'year';
  topic?: 'general' | 'news';
  domains?: string[];
  full_pages?: boolean;
}

export interface RawResult {
  url: string;
  title: string;
  content: string;
  published?: string | null;
}

export interface SearchProvider {
  search(query: string, args: Omit<SearchArgs, 'queries'>): Promise<RawResult[]>;
}

export class TavilyProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(query: string, args: Omit<SearchArgs, 'queries'>): Promise<RawResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: args.full_pages ? 4 : 6,
        search_depth: 'basic',
        topic: args.topic ?? 'general',
        ...(args.recency ? { time_range: args.recency } : {}),
        ...(args.domains?.length ? { include_domains: args.domains } : {}),
        ...(args.full_pages ? { include_raw_content: 'markdown' } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      results?: { url: string; title: string; content: string; raw_content?: string; published_date?: string }[];
    };
    return (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      content: (args.full_pages && r.raw_content) || r.content || '',
      published: r.published_date ? r.published_date.slice(0, 16) : null,
    }));
  }
}

/** Numbers every source seen while producing one answer. */
export class SourceRegistry {
  private byUrl = new Map<string, Source>();

  add(r: RawResult, nowMs: number): Source {
    const key = normalizeUrl(r.url);
    let s = this.byUrl.get(key);
    if (!s) {
      s = { n: this.byUrl.size + 1, url: r.url, title: r.title || r.url, published: r.published ?? null, retrievedAt: nowMs };
      this.byUrl.set(key, s);
    }
    return s;
  }

  all(): Source[] {
    return [...this.byUrl.values()];
  }
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) if (p.startsWith('utm_')) url.searchParams.delete(p);
    return `${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return u;
  }
}

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; results: RawResult[] }>();

export async function runSearch(
  provider: SearchProvider,
  args: SearchArgs,
  registry: SourceRegistry,
  nowMs: number,
): Promise<{ text: string; sources: Source[] }> {
  const queries = [...new Set(args.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
  const { queries: _q, ...opts } = args;

  const settled = await Promise.allSettled(
    queries.map(async (q) => {
      const key = JSON.stringify([q, opts]);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;
      const results = await provider.search(q, opts);
      cache.set(key, { at: Date.now(), results });
      return results;
    }),
  );

  const perChar = args.full_pages ? 6000 : 900;
  const blocks: string[] = [];
  const sources: Source[] = [];
  const seenThisCall = new Set<number>();

  settled.forEach((s, i) => {
    const filters = [args.recency && `last ${args.recency}`, args.domains?.length && `sites: ${args.domains.join(', ')}`]
      .filter(Boolean)
      .join('; ');
    blocks.push(`## Results for "${queries[i]}"${filters ? ` (${filters})` : ''}`);
    if (s.status === 'rejected') {
      blocks.push(`Search failed: ${String(s.reason?.message ?? s.reason).slice(0, 200)}`);
      return;
    }
    if (s.value.length === 0) blocks.push('No results.');
    for (const r of s.value) {
      const src = registry.add(r, nowMs);
      if (seenThisCall.has(src.n)) continue; // same page from two queries
      seenThisCall.add(src.n);
      sources.push(src);
      blocks.push(
        `[${src.n}] ${src.title}\nURL: ${src.url}\nPublished: ${src.published ?? 'unknown'}\n${clean(r.content).slice(0, perChar)}`,
      );
    }
  });

  return { text: blocks.join('\n\n'), sources };
}

function clean(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
