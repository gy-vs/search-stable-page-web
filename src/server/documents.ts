import type {DocState} from '../shared/search';

export type SearchDoc = {
  id: string;
  title: string;
  state: DocState;
  score: number;
};

const WORDS = ['query', 'relevance', 'ranking', 'recall', 'precision', 'index'];

/**
 * 种子数据故意制造大量同分：
 * - 10 条 score=100（其中前 7 条标题含 'judgments'，用于关键词筛选下的同分翻页）
 * - 随后每 3 条一组同分
 * 物理存储顺序按固定排列打乱，保证排序必须依赖稳定键而不是插入顺序。
 */
function seedDocs(): SearchDoc[] {
  const states: DocState[] = ['active', 'review', 'archived'];
  const docs: SearchDoc[] = [];
  for (let i = 0; i < 31; i++) {
    const id = `doc-${String(i).padStart(2, '0')}`;
    const score = i < 10 ? 100 : 90 - 3 * Math.floor((i - 10) / 3);
    const title = i < 7 ? `judgments ${id}` : `${WORDS[(i * 3 + 1) % WORDS.length]} ${id}`;
    docs.push({id, title, state: states[i % states.length], score});
  }
  // 确定性乱序：不是按 id 顺序存储
  return docs.sort((a, b) => {
    const ai = Number(a.id.slice(-2));
    const bi = Number(b.id.slice(-2));
    return ((ai * 37 + 11) % 41) - ((bi * 37 + 11) % 41);
  });
}

export class SearchIndex {
  #docs: Map<string, SearchDoc>;
  #revision = 1;

  constructor(initial: SearchDoc[] = seedDocs()) {
    this.#docs = new Map(initial.map((doc) => [doc.id, doc]));
  }

  get revision(): number {
    return this.#revision;
  }

  all(): SearchDoc[] {
    return [...this.#docs.values()];
  }

  get(id: string): SearchDoc | undefined {
    return this.#docs.get(id);
  }

  add(doc: SearchDoc): boolean {
    if (this.#docs.has(doc.id)) return false;
    this.#docs.set(doc.id, {...doc});
    this.#revision += 1;
    return true;
  }

  delete(id: string): boolean {
    const removed = this.#docs.delete(id);
    if (removed) this.#revision += 1;
    return removed;
  }
}
