import type { CatalogProduct } from './data.ts';

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'with', 'in', 'on', 'to', 'pack', 'box', 'set', 'x']);
const IRREGULAR: Record<string, string> = { mice: 'mouse' };

function stem(token: string): string {
  if (IRREGULAR[token]) return IRREGULAR[token];
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 0)
    .map(stem)
    .filter((t) => !STOP_WORDS.has(t));
}

type Doc = { product: CatalogProduct; tf: Map<string, number>; length: number };

// Field weights for a simplified BM25F: a title match counts more than a description match.
const FIELD_WEIGHTS = { title: 3, tags: 2, brand: 2, category: 1, description: 1 } as const;

export type ScoredProduct = { product: CatalogProduct; score: number };

// In-memory BM25 index over the catalog, with prefix expansion of the last query term for
// search-as-you-type on mobile.
export class SearchIndex {
  #docs: Doc[] = [];
  #df = new Map<string, number>();
  #avgLength = 0;
  #k1 = 1.2;
  #b = 0.75;

  constructor(products: CatalogProduct[]) {
    for (const product of products) {
      const tf = new Map<string, number>();
      let length = 0;
      const add = (text: string, weight: number) => {
        for (const token of tokenize(text)) {
          tf.set(token, (tf.get(token) ?? 0) + weight);
          length += weight;
        }
      };
      add(product.title, FIELD_WEIGHTS.title);
      add(product.tags.join(' '), FIELD_WEIGHTS.tags);
      add(product.brand, FIELD_WEIGHTS.brand);
      add(product.category, FIELD_WEIGHTS.category);
      add(product.description, FIELD_WEIGHTS.description);
      this.#docs.push({ product, tf, length });
      for (const term of tf.keys()) this.#df.set(term, (this.#df.get(term) ?? 0) + 1);
    }
    this.#avgLength = this.#docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.#docs.length);
  }

  #idf(term: string): number {
    const df = this.#df.get(term) ?? 0;
    const n = this.#docs.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  #expand(tokens: string[]): string[][] {
    return tokens.map((token, i) => {
      const isLast = i === tokens.length - 1;
      if (!isLast || token.length < 3) return [token];
      const prefixed = [...this.#df.keys()].filter((term) => term !== token && term.startsWith(token)).slice(0, 5);
      return [token, ...prefixed];
    });
  }

  search(query: string): ScoredProduct[] {
    const groups = this.#expand(tokenize(query));
    if (groups.length === 0) return [];
    const results: ScoredProduct[] = [];
    for (const doc of this.#docs) {
      let score = 0;
      for (const group of groups) {
        let best = 0;
        for (const term of group) {
          const tf = doc.tf.get(term);
          if (!tf) continue;
          const norm = tf + this.#k1 * (1 - this.#b + (this.#b * doc.length) / this.#avgLength);
          best = Math.max(best, (this.#idf(term) * (tf * (this.#k1 + 1))) / norm);
        }
        score += best;
      }
      if (score > 0) results.push({ product: doc.product, score });
    }
    return results.sort((a, b) => b.score - a.score || b.product.rating - a.product.rating);
  }
}
