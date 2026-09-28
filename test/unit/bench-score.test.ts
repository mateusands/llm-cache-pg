/*
 * Contract: the benchmark's numbers come from this function, so a mistake here would publish a
 * wrong table. The case below was computed by hand.
 */
import { describe, expect, it } from "vitest";
import { type BenchRecord, dedupePairs, score } from "../../bench/score.ts";

const records: BenchRecord[] = [
	// Duplicates: two found their own q1, one only at a low score, one found nothing.
	{ duplicate: true, similarity: 0.97, match: "own" },
	{ duplicate: true, similarity: 0.9, match: "own" },
	{ duplicate: true, similarity: 0.7, match: "own" },
	{ duplicate: true, similarity: null, match: null },
	// Non-duplicates: one scores high against its own q1 (the dangerous case), one lands on another pair.
	{ duplicate: false, similarity: 0.95, match: "own" },
	{ duplicate: false, similarity: 0.93, match: "other" },
];

describe("score", () => {
	it("should count hits at each threshold the way the README defines them", () => {
		const [at85, at94] = score(records, [0.85, 0.94]);

		// At 0.85: correct = 0.97 and 0.90; false = the non-duplicate at 0.95; other = 0.93.
		expect(at85).toEqual({
			threshold: 0.85,
			pairs: 6,
			duplicates: 4,
			hits: 4,
			correct: 2,
			falseHits: 1,
			otherPair: 1,
			hitRate: 0.5,
			falseHitRate: 0.25,
		});
		// At 0.94: correct = 0.97; false = 0.95.
		expect(at94).toMatchObject({
			hits: 2,
			correct: 1,
			falseHits: 1,
			otherPair: 0,
			hitRate: 0.25,
			falseHitRate: 0.5,
		});
	});

	it("should report a zero false-hit rate, not NaN, when nothing hits", () => {
		const [row] = score(records, [0.99]);
		expect(row).toMatchObject({ hits: 0, hitRate: 0, falseHitRate: 0 });
	});
});

describe("dedupePairs", () => {
	it("should drop pairs whose q1 was already stored or equals another pair's question", () => {
		const pairs = [
			{
				q1: "How do I learn Go?",
				q2: "Best way to learn Go?",
				duplicate: true,
			},
			// Same q1 as above, differently cased: its set() would be a no-op.
			{ q1: "how do i learn go", q2: "Is Go hard?", duplicate: false },
			// Its q2 is the first pair's q1: an exact hit on another pair.
			{ q1: "What is Rust?", q2: "How do I learn Go?", duplicate: false },
			// Its q1 is the first pair's q2.
			{ q1: "Best way to learn Go?", q2: "Go tutorials?", duplicate: true },
			{ q1: "Same text", q2: "same text.", duplicate: true },
			{ q1: "What is Zig?", q2: "Is Zig stable?", duplicate: false },
		];

		expect(dedupePairs(pairs, 10).map((p) => p.q1)).toEqual([
			"How do I learn Go?",
			"What is Zig?",
		]);
		expect(dedupePairs(pairs, 1)).toHaveLength(1);
	});
});
