/*
 * Contract: prune() removes only expired entries, in batches; invalidate() removes only what its
 * filters match and refuses to run without one. Both are explicit admin calls, so unlike lookups
 * they throw on failure instead of failing open.
 */
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createCache } from "../../src/cache.ts";
import type { KeyInput } from "../../src/key.ts";
import { migrate } from "../../src/migrate.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();
const embed = async () => [1, 0, 0];

function key(text: string, model = "m"): KeyInput {
	return { model, messages: [{ role: "user", content: text }] };
}

async function setup() {
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({
		pool,
		embed,
		table,
		onError: (e) => {
			throw e;
		},
	});
	const count = async (where = "true") =>
		(await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))
			.rows[0].n as number;
	return { cache, table, count };
}

describe("prune", () => {
	it("should delete expired entries and keep live ones", async () => {
		const { cache, count } = await setup();
		await cache.set(key("old 1"), 1, { ttl: 1 });
		await cache.set(key("old 2"), 2, { ttl: 1 });
		await cache.set(key("live"), 3, { ttl: "1h" });
		await cache.set(key("forever"), 4);
		await new Promise((r) => setTimeout(r, 20));

		expect(await cache.prune()).toBe(2);
		expect(await count()).toBe(2);
	});

	it("should delete in batches and report the total", async () => {
		const { cache, count } = await setup();
		for (let i = 0; i < 5; i++) await cache.set(key(`old ${i}`), i, { ttl: 1 });
		await new Promise((r) => setTimeout(r, 20));

		expect(await cache.prune({ batchSize: 2 })).toBe(5);
		expect(await count()).toBe(0);
	});

	it("should throw when the database is unreachable", async () => {
		const down = new pg.Pool({
			host: "127.0.0.1",
			port: 1,
			connectionTimeoutMillis: 500,
		});
		const cache = createCache({ pool: down, embed, onError: () => {} });
		await expect(cache.prune()).rejects.toThrow();
		await down.end();
	});
});

describe("invalidate", () => {
	it("should delete only the given namespace", async () => {
		const { cache, count } = await setup();
		await cache.set(key("a"), 1, { namespace: "t1" });
		await cache.set(key("b"), 2, { namespace: "t1" });
		await cache.set(key("a"), 3, { namespace: "t2" });

		expect(await cache.invalidate({ namespace: "t1" })).toBe(2);
		expect(await count("namespace = 't2'")).toBe(1);
	});

	it("should delete only the given model", async () => {
		const { cache, count } = await setup();
		await cache.set(key("a", "m1"), 1);
		await cache.set(key("a", "m2"), 2);

		expect(await cache.invalidate({ model: "m1" })).toBe(1);
		expect(await count("model = 'm2'")).toBe(1);
	});

	it("should delete one exact key in the default namespace only", async () => {
		const { cache, count } = await setup();
		await cache.set(key("wrong answer"), 1);
		await cache.set(key("other"), 2);
		await cache.set(key("wrong answer"), 3, { namespace: "t2" });

		expect(await cache.invalidate({ key: key("wrong answer") })).toBe(1);
		expect(await cache.get(key("wrong answer"))).toMatchObject({
			response: 2,
			result: "semantic_hit",
		});
		expect(await count()).toBe(2);
	});

	it("should combine filters", async () => {
		const { cache, count } = await setup();
		await cache.set(key("a", "m1"), 1, { namespace: "t1" });
		await cache.set(key("a", "m2"), 2, { namespace: "t1" });
		await cache.set(key("a", "m1"), 3, { namespace: "t2" });

		expect(await cache.invalidate({ namespace: "t1", model: "m1" })).toBe(1);
		expect(await count()).toBe(2);
	});

	it("should refuse to run without a filter", async () => {
		const { cache, count } = await setup();
		await cache.set(key("a"), 1);

		await expect(cache.invalidate({})).rejects.toThrow(/filter/);
		expect(await count()).toBe(1);
	});

	it("should refuse a key that could never be cached", async () => {
		const { cache } = await setup();
		await expect(
			cache.invalidate({ key: { model: "m", messages: [] } }),
		).rejects.toThrow(/cacheable/);
	});
});
