/*
 * Contract: lookups only ever see live rows of the same namespace, model, key version and
 * partition. Writes keep a live row and replace an expired one.
 */
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { type CacheKey, deriveKey } from "../../src/key.ts";
import { migrate } from "../../src/migrate.ts";
import {
	findExact,
	findNearest,
	insertEntry,
	type NewEntry,
	recordHit,
	type StoreConfig,
} from "../../src/store.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();
const table = uniqueTable();
const config: StoreConfig = {
	table,
	iterativeScan: true,
	lookupTimeoutMs: 1000,
	writeTimeoutMs: 5000,
};

beforeAll(() => migrate(pool, { table, dimensions: 3 }));

function keyFor(text: string, system = "You are a support bot."): CacheKey {
	const k = deriveKey({
		model: "m",
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: text },
		],
	});
	if (!k) throw new Error("not cacheable");
	return k;
}

function entry(overrides: Partial<NewEntry> & { key: CacheKey }): NewEntry {
	return {
		namespace: "ns",
		embedding: [1, 0, 0],
		response: { answer: "a" },
		ttlMs: null,
		...overrides,
	};
}

describe("findExact", () => {
	it("should find a stored entry by its exact key", async () => {
		const key = keyFor("exact 1");
		await insertEntry(
			pool,
			config,
			entry({ key, response: { answer: "stored" } }),
		);

		const match = await findExact(pool, config, "ns", key);

		expect(match?.response).toEqual({ answer: "stored" });
		expect(match?.similarity).toBe(1);
	});

	it("should not find it from another namespace", async () => {
		const key = keyFor("exact 2");
		await insertEntry(pool, config, entry({ key }));

		expect(await findExact(pool, config, "other", key)).toBeNull();
	});

	it("should not find it once expired", async () => {
		const key = keyFor("exact 3");
		await insertEntry(pool, config, entry({ key, ttlMs: 1 }));
		await new Promise((r) => setTimeout(r, 20));

		expect(await findExact(pool, config, "ns", key)).toBeNull();
	});

	it("should not find rows written under another key version", async () => {
		const key = keyFor("exact 4");
		await insertEntry(pool, config, entry({ key }));
		await pool.query(
			`UPDATE ${table} SET key_version = 99 WHERE prompt_hash = $1`,
			[key.promptHash],
		);

		expect(await findExact(pool, config, "ns", key)).toBeNull();
	});
});

describe("insertEntry", () => {
	it("should keep the live entry when the same key is stored again", async () => {
		const key = keyFor("write 1");
		await insertEntry(
			pool,
			config,
			entry({ key, response: { answer: "first" } }),
		);
		await insertEntry(
			pool,
			config,
			entry({ key, response: { answer: "second" } }),
		);

		expect((await findExact(pool, config, "ns", key))?.response).toEqual({
			answer: "first",
		});
	});

	it("should replace an expired entry, so the key becomes cacheable again", async () => {
		const key = keyFor("write 2");
		await insertEntry(
			pool,
			config,
			entry({ key, response: { answer: "old" }, ttlMs: 1 }),
		);
		await new Promise((r) => setTimeout(r, 20));
		await insertEntry(
			pool,
			config,
			entry({ key, response: { answer: "new" } }),
		);

		expect((await findExact(pool, config, "ns", key))?.response).toEqual({
			answer: "new",
		});
	});

	it("should count hits", async () => {
		const key = keyFor("write 3");
		await insertEntry(pool, config, entry({ key }));
		const match = await findExact(pool, config, "ns", key);
		if (!match) throw new Error("missing");

		await recordHit(pool, config, match.id);
		await recordHit(pool, config, match.id);

		const { rows } = await pool.query(
			`SELECT hits, last_hit_at FROM ${table} WHERE id = $1`,
			[match.id],
		);
		expect(rows[0].hits).toBe(2);
		expect(rows[0].last_hit_at).not.toBeNull();
	});
});

describe("findNearest", () => {
	it("should return the closest entry in the partition with its similarity", async () => {
		const ns = "nearest-1";
		await insertEntry(
			pool,
			config,
			entry({ namespace: ns, key: keyFor("far"), embedding: [0, 1, 0] }),
		);
		await insertEntry(
			pool,
			config,
			entry({
				namespace: ns,
				key: keyFor("close"),
				embedding: [1, 0.1, 0],
				response: { answer: "close" },
			}),
		);

		const match = await findNearest(
			pool,
			config,
			ns,
			keyFor("query"),
			[1, 0, 0],
		);

		expect(match?.response).toEqual({ answer: "close" });
		expect(match?.similarity).toBeCloseTo(0.995, 3);
	});

	it("should ignore entries from another partition, however close", async () => {
		const ns = "nearest-2";
		await insertEntry(
			pool,
			config,
			entry({
				namespace: ns,
				key: keyFor("same", "Other prompt"),
				embedding: [1, 0, 0],
			}),
		);

		expect(
			await findNearest(pool, config, ns, keyFor("query"), [1, 0, 0]),
		).toBeNull();
	});
});

describe("findNearest in a busy table", () => {
	const busy = uniqueTable();
	const busyConfig = { ...config, table: busy };
	// Spread out on purpose: with 10k points on one line, a far point is unreachable in the HNSW graph
	// even unfiltered (measured). Forcing the HNSW plan is what exposes the filtering failure.
	const forcedHnsw = new pg.Pool({
		connectionString: pool.options.connectionString,
		options: "-c enable_seqscan=off -c enable_sort=off",
		max: 2,
	});

	beforeAll(async () => {
		await migrate(pool, { table: busy, dimensions: 3 });
		const k = keyFor("busy");
		await pool.query(
			`INSERT INTO ${busy} (namespace, model, key_version, params_hash, prompt_hash, prompt_text, embedding, response)
			 SELECT 'crowd', $1, 1, $2, md5(i::text), 't', format('[1,%s,%s]', (i * 7919 % 1000) / 3333.0, (i * 104729 % 997) / 3333.0)::vector, '{}'
			 FROM generate_series(1, 10000) AS i`,
			[k.model, k.paramsHash],
		);
		await insertEntry(
			pool,
			busyConfig,
			entry({
				namespace: "target",
				key: k,
				embedding: [0.3, 0.5, 0.8],
				response: { answer: "target" },
			}),
		);
		return () => forcedHnsw.end();
	}, 60_000);

	it("should miss the entry without iterative scans (proves the test reaches the failure mode)", async () => {
		const match = await findNearest(
			forcedHnsw,
			{ ...busyConfig, iterativeScan: false },
			"target",
			keyFor("busy"),
			[1, 0, 0],
		);
		expect(match).toBeNull();
	});

	it("should find the only entry of its namespace among 10k closer entries of another", async () => {
		const match = await findNearest(
			forcedHnsw,
			busyConfig,
			"target",
			keyFor("busy"),
			[1, 0, 0],
		);
		expect(match?.response).toEqual({ answer: "target" });
	});
});
