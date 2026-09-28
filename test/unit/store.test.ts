import { describe, expect, it } from "vitest";
import { lookupPreamble } from "../../src/store.ts";

describe("lookupPreamble", () => {
	it("should enable iterative index scans when pgvector supports them", () => {
		expect(lookupPreamble({ iterativeScan: true, lookupTimeoutMs: 200 })).toBe(
			"BEGIN READ ONLY; SET LOCAL statement_timeout = 200; SET LOCAL hnsw.iterative_scan = relaxed_order",
		);
	});

	it("should leave the setting out on older pgvector, where it is an error", () => {
		expect(
			lookupPreamble({ iterativeScan: false, lookupTimeoutMs: 200 }),
		).not.toContain("hnsw");
	});
});
