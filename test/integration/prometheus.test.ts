/*
 * Contract: prometheusHooks turns lookup events and errors into Prometheus metrics without ever
 * putting prompt or response text in a label, and a scrape never fails or hangs because of the
 * database.
 */
import { createServer, type Socket } from "node:net";
import * as client from "@prometheus-io/client";
import { Registry } from "@prometheus-io/client";
import pg from "pg";
import * as legacy from "prom-client";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCache } from "../../src/cache.ts";
import type { KeyInput } from "../../src/key.ts";
import { migrate } from "../../src/migrate.ts";
import { prometheusHooks } from "../../src/prometheus.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();

const vectors: Record<string, number[]> = {
	"reset password": [1, 0, 0],
	"reset my password": [0.99, 0.14, 0],
	"cancel order": [0, 1, 0],
};
const embed = async (text: string) => vectors[text] ?? [0, 0, 1];

function key(text: string): KeyInput {
	return { model: "m", messages: [{ role: "user", content: text }] };
}

async function setup(
	options: { namespaceLabel?: boolean; registry?: Registry } = {},
) {
	const registry = options.registry ?? new Registry();
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const hooks = prometheusHooks({ client, registry, pool, table, ...options });
	const cache = createCache({ pool, embed, table, awaitStore: true, ...hooks });
	const ask = (text: string, namespace?: string) =>
		cache.wrap(async () => ({ a: text }), {
			key: key(text),
			usage: () => ({ input: 100, output: 40 }),
			...(namespace ? { namespace } : {}),
		});
	const value = async (name: string, labels: Record<string, string> = {}) => {
		const metric = await registry.getSingleMetric(name)?.get();
		const match = metric?.values.find((v) =>
			Object.entries(labels).every(([k, l]) => String(v.labels[k]) === l),
		);
		return match?.value;
	};
	return { registry, table, cache, ask, value };
}

describe("prometheusHooks", () => {
	it("should count lookups by result", async () => {
		const { ask, cache, value } = await setup();

		await ask("reset password");
		await ask("reset password");
		await ask("reset my password");
		await cache.wrap(async () => 1, { key: { model: "m", messages: [] } });

		expect(await value("llm_cache_requests_total", { result: "miss" })).toBe(1);
		expect(
			await value("llm_cache_requests_total", { result: "exact_hit" }),
		).toBe(1);
		expect(
			await value("llm_cache_requests_total", { result: "semantic_hit" }),
		).toBe(1);
		expect(await value("llm_cache_requests_total", { result: "bypass" })).toBe(
			1,
		);
	});

	it("should add up the tokens that hits saved, and nothing for misses", async () => {
		const { ask, value } = await setup();

		await ask("reset password");
		await ask("reset password");
		await ask("reset my password");

		expect(
			await value("llm_cache_tokens_saved_total", { direction: "in" }),
		).toBe(200);
		expect(
			await value("llm_cache_tokens_saved_total", { direction: "out" }),
		).toBe(80);
	});

	it("should observe lookup duration per stage and the best similarity", async () => {
		const { ask, value } = await setup();

		await ask("reset password");
		await ask("cancel order");

		expect(
			await value("llm_cache_lookup_duration_seconds", {
				stage: "exact",
				le: "+Inf",
			}),
		).toBe(2);
		expect(
			await value("llm_cache_lookup_duration_seconds", {
				stage: "embed",
				le: "+Inf",
			}),
		).toBe(2);
		// Only the second lookup had a candidate to compare against.
		expect(await value("llm_cache_similarity", { le: "+Inf" })).toBe(1);
		expect(await value("llm_cache_similarity", { le: "0.5" })).toBe(1);
	});

	it("should have buckets fine enough for sub-millisecond lookups", async () => {
		const { ask, value } = await setup();

		await ask("reset password");

		expect(
			await value("llm_cache_lookup_duration_seconds", {
				stage: "exact",
				le: "0.0005",
			}),
		).toBeDefined();
	});

	it("should count shadow lookups apart and never as savings", async () => {
		const { cache, value } = await setup();
		const shadowAsk = (text: string) =>
			cache.wrap(async () => ({ a: text }), {
				key: key(text),
				shadow: true,
				usage: () => ({ input: 100, output: 40 }),
			});

		await shadowAsk("reset password");
		await shadowAsk("reset password");

		expect(
			await value("llm_cache_shadow_lookups_total", { result: "miss" }),
		).toBe(1);
		expect(
			await value("llm_cache_shadow_lookups_total", { result: "exact_hit" }),
		).toBe(1);
		expect(
			await value("llm_cache_requests_total", { result: "miss" }),
		).toBeUndefined();
		expect(
			await value("llm_cache_tokens_saved_total", { direction: "in" }),
		).toBeUndefined();
	});

	it("should label shadow lookups by namespace when asked", async () => {
		const { cache, value } = await setup({ namespaceLabel: true });

		await cache.wrap(async () => 1, {
			key: key("reset password"),
			namespace: "tenant-1",
			shadow: true,
		});

		expect(
			await value("llm_cache_shadow_lookups_total", {
				namespace: "tenant-1",
				result: "miss",
			}),
		).toBe(1);
	});

	it("should count errors by stage", async () => {
		const registry = new Registry();
		const hooks = prometheusHooks({ client, registry });
		const cache = createCache({ pool, embed, table: uniqueTable(), ...hooks });

		await cache.wrap(async () => 1, { key: key("x") });

		const metric = await registry
			.getSingleMetric("llm_cache_errors_total")
			?.get();
		expect(metric?.values).toEqual([{ labels: { stage: "setup" }, value: 1 }]);
	});

	it("should label by namespace only when asked", async () => {
		const plain = await setup();
		await plain.ask("reset password", "tenant-1");
		expect(await plain.registry.metrics()).not.toContain("tenant-1");

		const labelled = await setup({ namespaceLabel: true });
		await labelled.ask("reset password", "tenant-1");
		expect(
			await labelled.value("llm_cache_requests_total", {
				namespace: "tenant-1",
				result: "miss",
			}),
		).toBe(1);
	});

	it("should allow several caches on one registry", async () => {
		const registry = new Registry();
		const a = await setup({ registry });
		const b = await setup({ registry });

		await a.ask("reset password");
		await b.ask("reset password");

		expect(await a.value("llm_cache_requests_total", { result: "miss" })).toBe(
			2,
		);
	});

	it("should report the entry count per table from Postgres statistics", async () => {
		const { ask, table, value } = await setup();
		await ask("reset password");
		await ask("cancel order");
		await pool.query(`ANALYZE ${table}`);

		const stats = await pool.query(
			"SELECT n_live_tup::float8 AS n FROM pg_stat_user_tables WHERE relid = to_regclass($1)",
			[table],
		);
		expect(await value("llm_cache_entries", { table })).toBe(stats.rows[0].n);
	});

	it("should finish a scrape quickly when the database never answers", async () => {
		const sockets: Socket[] = [];
		const server = createServer((s) => sockets.push(s));
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		// No connectionTimeoutMillis: the pool would wait forever on its own.
		const hung = new pg.Pool({
			host: "127.0.0.1",
			port: address.port,
			user: "x",
			database: "x",
		});
		onTestFinished(async () => {
			for (const s of sockets) s.destroy();
			server.close();
			await hung.end().catch(() => {});
		});
		const registry = new Registry();
		prometheusHooks({
			client,
			registry,
			pool: hung,
			table: "llm_cache_entries",
		});

		const started = performance.now();
		await expect(registry.metrics()).resolves.toContain("llm_cache_entries");

		expect(performance.now() - started).toBeLessThan(2000);
	});

	it("should also work with the older prom-client package", async () => {
		const registry = new legacy.Registry();
		const table = uniqueTable();
		await migrate(pool, { table, dimensions: 3 });
		const cache = createCache({
			pool,
			embed,
			table,
			...prometheusHooks({ client: legacy, registry }),
		});

		await cache.wrap(async () => 1, { key: key("reset password") });

		expect(await registry.metrics()).toContain(
			'llm_cache_requests_total{result="miss"} 1',
		);
	});

	it("should refuse a second setup on one registry with a different namespace label", () => {
		const registry = new Registry();
		prometheusHooks({ client, registry });
		expect(() =>
			prometheusHooks({ client, registry, namespaceLabel: true }),
		).toThrow(/namespaceLabel/);
	});
});
