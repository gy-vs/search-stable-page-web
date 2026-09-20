// In-memory search index with a monotonically increasing revision.
// Every mutation (insert / delete) bumps the revision, which is what
// cursors are pinned to: a cursor is only valid against the revision
// of the index that produced it.

export type Doc = {
  id: string;
  title: string;
  content: string;
  tags: string[];
};

export type ScoredDoc = Doc & {score: number};

export type SortDirection = 'asc' | 'desc';

export type SearchQuery = {
  q: string;
  tag: string | null;
  sortDir: SortDirection;
};

/**
 * Total-order comparator over the stable sort key (score, id).
 * The primary key is the score in the requested direction; the
 * tie-breaker is the document id, ALWAYS ascending, so the order is
 * total and identical for every request against the same revision —
 * regardless of how many documents share a score.
 */
export function compareKeys(
  a: {score: number; id: string},
  b: {score: number; id: string},
  sortDir: SortDirection,
): number {
  let cmp = a.score - b.score;
  if (sortDir === 'desc') cmp = -cmp;
  if (cmp !== 0) return cmp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Deterministic score: title hits weigh double. Empty query => 0 for all (maximal ties). */
export function scoreDoc(doc: Doc, terms: string[]): number {
  const title = doc.title.toLowerCase();
  const content = doc.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += 2 * countOccurrences(title, term) + countOccurrences(content, term);
  }
  return score;
}

export class SearchIndex {
  private docs = new Map<string, Doc>();
  private rev = 0;

  constructor(seed: Doc[] = []) {
    for (const doc of seed) this.docs.set(doc.id, doc);
  }

  get revision(): number {
    return this.rev;
  }

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  insert(doc: Doc): void {
    if (this.docs.has(doc.id)) throw new Error(`duplicate id: ${doc.id}`);
    this.docs.set(doc.id, doc);
    this.rev += 1;
  }

  remove(id: string): boolean {
    const existed = this.docs.delete(id);
    if (existed) this.rev += 1;
    return existed;
  }

  /**
   * Keyset pagination: returns up to `limit` documents strictly AFTER
   * `afterKey` in the total order, or from the beginning when omitted.
   * Scores are a pure function of (docs, query), and the revision pins
   * the docs, so successive pages are consistent within a revision.
   */
  search(query: SearchQuery, afterKey: [number, string] | null, limit: number): ScoredDoc[] {
    const terms = tokenize(query.q);
    const scored: ScoredDoc[] = [];
    for (const doc of this.docs.values()) {
      if (query.tag && !doc.tags.includes(query.tag)) continue;
      const score = scoreDoc(doc, terms);
      if (terms.length > 0 && score === 0) continue; // query present: only matching docs
      scored.push({...doc, score});
    }
    const cmp = (a: {score: number; id: string}, b: {score: number; id: string}) =>
      compareKeys(a, b, query.sortDir);
    scored.sort(cmp);
    let out = scored;
    if (afterKey) {
      const key = {score: afterKey[0], id: afterKey[1]};
      out = scored.filter((doc) => cmp(doc, key) > 0);
    }
    return out.slice(0, limit);
  }
}

/** Deterministic seed data (no randomness) so dev and tests are reproducible. */
export function seedDocs(): Doc[] {
  const topics = ['ranking', 'cursor', 'relevance', 'judgment', 'token', 'index'];
  const docs: Doc[] = [];
  for (let i = 1; i <= 60; i += 1) {
    const id = `doc-${String(i).padStart(3, '0')}`;
    const a = topics[i % topics.length];
    const b = topics[(i * 7) % topics.length];
    docs.push({
      id,
      title: `${a} notes ${i}`,
      content: `${a} ${b} `.repeat((i % 4) + 1).trim(),
      tags: [i % 2 === 0 ? 'even' : 'odd', i % 3 === 0 ? 'tri' : 'plain'],
    });
  }
  return docs;
}
