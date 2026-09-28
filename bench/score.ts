/** One q2 lookup: whether its pair is a labelled duplicate, and the best candidate it found. */
export interface BenchRecord {
	duplicate: boolean;
	/** Best similarity in the namespace, or null when there was no candidate. */
	similarity: number | null;
	/** Whose q1 the candidate was: this pair's, another pair's, or none. */
	match: "own" | "other" | null;
}

export interface ScoreRow {
	threshold: number;
	pairs: number;
	duplicates: number;
	hits: number;
	/** Hits on the pair's own q1, for a duplicate pair. */
	correct: number;
	/** Hits on the pair's own q1, for a pair labelled NOT duplicate: a wrong answer served. */
	falseHits: number;
	/** Hits on another pair's q1. Unlabelled, so neither correct nor false; reported apart. */
	otherPair: number;
	/** correct / duplicates: how many real repeats the cache would answer. */
	hitRate: number;
	/** falseHits / hits: how many served answers are known to be wrong. */
	falseHitRate: number;
}

export function score(
	records: readonly BenchRecord[],
	thresholds: readonly number[],
): ScoreRow[] {
	const duplicates = records.filter((r) => r.duplicate).length;
	return thresholds.map((threshold) => {
		const hits = records.filter(
			(r) => r.similarity !== null && r.similarity >= threshold,
		);
		const correct = hits.filter((r) => r.match === "own" && r.duplicate).length;
		const falseHits = hits.filter(
			(r) => r.match === "own" && !r.duplicate,
		).length;
		const otherPair = hits.filter((r) => r.match === "other").length;
		return {
			threshold,
			pairs: records.length,
			duplicates,
			hits: hits.length,
			correct,
			falseHits,
			otherPair,
			hitRate: duplicates ? correct / duplicates : 0,
			falseHitRate: hits.length ? falseHits / hits.length : 0,
		};
	});
}

export interface Pair {
	q1: string;
	q2: string;
	duplicate: boolean;
}

const normalize = (text: string) =>
	text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[?.!\s]+$/, "")
		.trim();

/**
 * Pairs with distinct q1 texts, and no q2 equal to any q1: otherwise a pair's q1 is never stored
 * (the earlier row wins) and its q2 can only land on another pair, scoring a false hit by accident.
 */
export function dedupePairs(
	candidates: readonly Pair[],
	limit: number,
): Pair[] {
	const q1s = new Set<string>();
	const q2s = new Set<string>();
	const picked: Pair[] = [];
	for (const pair of candidates) {
		const a = normalize(pair.q1);
		const b = normalize(pair.q2);
		if (!a || !b || a === b || q1s.has(a) || q2s.has(a) || q1s.has(b)) continue;
		q1s.add(a);
		q2s.add(b);
		picked.push(pair);
		if (picked.length === limit) break;
	}
	return picked;
}
