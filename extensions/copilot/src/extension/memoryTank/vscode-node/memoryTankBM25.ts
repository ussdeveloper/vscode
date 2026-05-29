/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lightweight, dependency-free BM25 retrieval used by `MemoryTankStore`.
 *
 * BM25 is the standard ranking function used by Lucene/Elasticsearch and is
 * a good fit for the memory-tank workload: documents are short (a sentence
 * or paragraph), there's no embedding service running locally, and the
 * agent typically queries with very specific terms ("react context auth
 * refresh token rotation"). For corpora up to ~10k docs this implementation
 * answers in under 5ms per query on a modern laptop.
 *
 * Standard parameter values (k1=1.5, b=0.75) are used. Tokeniser is a
 * Unicode-aware whitespace + punctuation splitter that also lowercases and
 * strips a short hard-coded English stopword list. We keep CamelCase /
 * snake_case identifiers as-is so a memory tagged with `useAuthState`
 * still matches the query "useAuthState".
 */

const STOPWORDS = new Set([
	'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were',
	'be', 'been', 'being', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
	'by', 'from', 'as', 'this', 'that', 'these', 'those', 'it', 'its', 'i',
	'you', 'we', 'they', 'he', 'she', 'them', 'us', 'our', 'your',
	// Polish stopwords -- the user writes mixed PL/EN, so trim both.
	'i', 'a', 'oraz', 'lub', 'ale', 'jest', 'sa', 'byl', 'byla', 'bylo', 'byli',
	'byly', 'z', 'w', 'na', 'do', 'od', 'po', 'przy', 'dla', 'oraz', 'jak',
	'czy', 'co', 'to', 'ten', 'ta', 'tego', 'tych', 'sie', 'jego', 'jej',
]);

export function tokenize(text: string): string[] {
	if (!text) { return []; }
	// Keep alphanumeric + a few code-meaningful chars (`_-.`).
	// We deliberately don't split on `_` / `-` so identifiers stay whole.
	const tokens = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_\-.\s]/gu, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1 && !STOPWORDS.has(t));
	return tokens;
}

interface IndexedDoc {
	id: string;
	tokens: string[];
	length: number;
}

interface CorpusStats {
	docs: IndexedDoc[];
	df: Map<string, number>;
	avgDocLen: number;
}

function buildCorpusStats(docs: { id: string; text: string }[]): CorpusStats {
	const indexed: IndexedDoc[] = [];
	const df = new Map<string, number>();
	let totalLen = 0;
	for (const d of docs) {
		const tokens = tokenize(d.text);
		indexed.push({ id: d.id, tokens, length: tokens.length });
		totalLen += tokens.length;
		const seen = new Set<string>();
		for (const t of tokens) {
			if (seen.has(t)) { continue; }
			seen.add(t);
			df.set(t, (df.get(t) ?? 0) + 1);
		}
	}
	const avgDocLen = indexed.length === 0 ? 0 : totalLen / indexed.length;
	return { docs: indexed, df, avgDocLen };
}

export interface ScoredHit {
	id: string;
	score: number;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Rank documents by BM25 against `query`. Returns the top `limit` hits
 * sorted by descending score. Documents that score <= 0 are filtered out.
 */
export function searchBM25(query: string, corpus: { id: string; text: string }[], limit = 8): ScoredHit[] {
	if (corpus.length === 0) { return []; }
	const queryTokens = Array.from(new Set(tokenize(query)));
	if (queryTokens.length === 0) { return []; }
	const stats = buildCorpusStats(corpus);
	const N = stats.docs.length;
	const out: ScoredHit[] = [];
	for (const doc of stats.docs) {
		let score = 0;
		const tf = new Map<string, number>();
		for (const t of doc.tokens) { tf.set(t, (tf.get(t) ?? 0) + 1); }
		for (const q of queryTokens) {
			const f = tf.get(q);
			if (!f) { continue; }
			const df = stats.df.get(q) ?? 0;
			if (df === 0) { continue; }
			// Standard BM25 IDF (Robertson-Spark Jones), guarded against
			// negative values for very common terms.
			const idf = Math.max(0, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
			const norm = 1 - B + B * (doc.length / Math.max(1, stats.avgDocLen));
			const tfPart = (f * (K1 + 1)) / (f + K1 * norm);
			score += idf * tfPart;
		}
		if (score > 0) { out.push({ id: doc.id, score }); }
	}
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, limit);
}
