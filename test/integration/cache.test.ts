/*
 * Contract: a repeated or paraphrased question is answered from Postgres without calling the model,
 * but only within the same namespace and exact partition (model, params, system prompt, prior
 * turns). A false hit is worse than a miss. The cache fails open: whatever
 * breaks inside it, the caller still gets the model's answer.
 */
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	type CacheOptions,
	createCache,
	type ErrorStage,
	type LookupEvent,
	type ShadowEvent,
} from "../../src/cache.ts";
import type { KeyInput } from "../../src/key.ts";
import { migrate } from "../../src/migrate.ts";
import { TimeoutError } from "../../src/pg.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();

const VECTORS: Record<string, number[]> = {
	"How do I reset my password?": [1, 0, 0],
	// cos ~0.98 to the one above: a paraphrase.
	"forgot my password, what now?": [0.98, 0.2, 0],
	// cos ~0.85: related, but under the 0.92 threshold.
	"How do I change my email?": [0.85, 0.53, 0],
	"cancel my order": [0, 1, 0],
};

async function embed(text: string): Promise<number[]> {
	const v = VECTORS[text];
	if (!v) throw new Error(`no test vector for ${text}`);
	return v;
}

function request(text: string, overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		model: "gpt-test",
		messages: [
			{ role: "system", content: "You are a support bot." },
			{ role: "user", content: text },
		],
		params: { temperature: 0 },
		...overrides,
	};
}

function setup(options: Partial<CacheOptions> = {}) {
	const table = uniqueTable();
	const events: LookupEvent[] = [];
	const errors: { stage: ErrorStage; error: unknown }[] = [];
	const cache = createCache({
		pool,
		embed,
		table,
		awaitStore: true,
		onLookup: (e) => events.push(e),
		onError: (error, stage) => errors.push({ stage, error }),
		...options,
	});
	let calls = 0;
	const llm = async (text: string) => {
		calls++;
		return { answer: `answer to ${text}`, n: calls };
	};
	const ask = (
		text: string,
		overrides?: Partial<KeyInput>,
		namespace?: string,
	) =>
		cache.wrap(() => llm(text), {
			key: request(text, overrides),
			...(namespace ? { namespace } : {}),
		});
	return { table, cache, events, errors, ask, calls: () => calls };
}

async function migrated(options: Partial<CacheOptions> = {}) {
	const s = setup(options);
	await migrate(pool, { table: s.table, dimensions: 3 });
	return s;
}

describe("cache hits", () => {
	it("should answer a repeated question from the cache without calling the model", async () => {
		const { ask, calls, events } = await migrated();

		const first = await ask("How do I reset my password?");
		const second = await ask("How do I reset my password?");

		expect(second).toEqual(first);
		expect(calls()).toBe(1);
		expect(events.map((e) => e.result)).toEqual(["miss", "exact_hit"]);
	});

	it("should answer a paraphrase above the threshold from the cache", async () => {
		const { ask, calls, events } = await migrated();

		const first = await ask("How do I reset my password?");
		const second = await ask("forgot my password, what now?");

		expect(second).toEqual(first);
		expect(calls()).toBe(1);
		expect(events[1]?.result).toBe("semantic_hit");
		expect(events[1]?.similarity).toBeGreaterThan(0.97);
	});

	it("should call the model when the closest entry is under the threshold", async () => {
		const { ask, calls, events } = await migrated();

		await ask("How do I reset my password?");
		await ask("How do I change my email?");

		expect(calls()).toBe(2);
		expect(events[1]).toMatchObject({ result: "miss" });
		expect(events[1]?.similarity).toBeCloseTo(0.85, 2);
	});

	it("should honor a custom threshold", async () => {
		const { ask, calls } = await migrated({ threshold: 0.8 });

		await ask("How do I reset my password?");
		await ask("How do I change my email?");

		expect(calls()).toBe(1);
	});
});

describe("lookup events", () => {
	it("should report how long each stage took", async () => {
		const { ask, events } = await migrated();

		await ask("How do I reset my password?");
		await ask("How do I reset my password?");

		expect(Object.keys(events[0]?.durations ?? {}).sort()).toEqual([
			"embed",
			"exact",
			"semantic",
		]);
		expect(Object.keys(events[1]?.durations ?? {})).toEqual(["exact"]);
		expect(events[0]?.durations.exact).toBeGreaterThan(0);
	});

	it("should report the tokens a hit saved", async () => {
		const { cache, events } = await migrated();
		const key = request("How do I reset my password?");
		const fn = async () => ({ answer: "a" });

		await cache.wrap(fn, { key, usage: () => ({ input: 30, output: 12 }) });
		await cache.wrap(fn, { key });

		expect(events[0]?.tokens).toBeUndefined();
		expect(events[1]?.tokens).toEqual({ input: 30, output: 12 });
	});
});

describe("partition isolation", () => {
	it("should never answer from another namespace", async () => {
		const { ask, calls } = await migrated();

		await ask("How do I reset my password?", {}, "tenant-a");
		await ask("How do I reset my password?", {}, "tenant-b");

		expect(calls()).toBe(2);
	});

	const variants: [string, Partial<KeyInput>][] = [
		["the model", { model: "gpt-other" }],
		["a generation param", { params: { temperature: 1 } }],
		[
			"the system prompt",
			{
				messages: [
					{ role: "system", content: "You are a pirate." },
					{ role: "user", content: "forgot my password, what now?" },
				],
			},
		],
		[
			"the earlier turns",
			{
				messages: [
					{ role: "system", content: "You are a support bot." },
					{ role: "user", content: "I use the mobile app." },
					{ role: "assistant", content: "Got it." },
					{ role: "user", content: "forgot my password, what now?" },
				],
			},
		],
	];

	it.each(variants)(
		"should not hit, exact or semantic, when %s differs",
		async (_, overrides) => {
			const exact = await migrated();
			await exact.ask("How do I reset my password?");
			await exact.ask(
				"How do I reset my password?",
				withText(overrides, "How do I reset my password?"),
			);
			expect(exact.calls()).toBe(2);

			const semantic = await migrated();
			await semantic.ask("How do I reset my password?");
			await semantic.ask(
				"forgot my password, what now?",
				withText(overrides, "forgot my password, what now?"),
			);
			expect(semantic.calls()).toBe(2);
		},
	);
});

/** The variant's overrides with `text` as the last user message. */
function withText(
	overrides: Partial<KeyInput>,
	text: string,
): Partial<KeyInput> {
	if (!overrides.messages) return overrides;
	return {
		...overrides,
		messages: [
			...overrides.messages.slice(0, -1),
			{ role: "user", content: text },
		],
	};
}

describe("per-call threshold and exact-only mode", () => {
	it("should apply a threshold given on the call", async () => {
		const { ask, cache } = await migrated();
		await ask("How do I reset my password?");

		// cos ~0.85 to the stored question.
		expect(
			await cache.get(request("How do I change my email?"), {
				threshold: 0.99,
			}),
		).toBeNull();
		expect(
			await cache.get(request("How do I change my email?"), { threshold: 0.8 }),
		).toMatchObject({
			result: "semantic_hit",
		});
	});

	it("should skip embeddings and semantic lookups when semantic is off", async () => {
		let embeds = 0;
		const counting: CacheOptions["embed"] = async (text) => {
			embeds++;
			return embed(text);
		};
		const { ask, calls, events, table } = await migrated({
			embed: counting,
			semantic: false,
		});

		await ask("How do I reset my password?");
		await ask("forgot my password, what now?");
		await ask("How do I reset my password?");

		expect(embeds).toBe(0);
		expect(calls()).toBe(2);
		expect(events.map((e) => e.result)).toEqual(["miss", "miss", "exact_hit"]);
		expect(events[0]?.durations).not.toHaveProperty("embed");
		const { rows } = await pool.query(
			`SELECT count(*)::int AS n FROM ${table} WHERE embedding IS NULL`,
		);
		expect(rows[0].n).toBe(2);
	});

	it("should let a call turn semantic lookups back on", async () => {
		const { ask, cache } = await migrated({ semantic: false });
		await cache.set(
			request("How do I reset my password?"),
			{ answer: "stored" },
			{ semantic: true },
		);

		const found = await cache.get(request("forgot my password, what now?"), {
			semantic: true,
		});

		expect(found).toMatchObject({
			result: "semantic_hit",
			response: { answer: "stored" },
		});
		await ask("unrelated");
	});

	it("should never return an entry stored without an embedding from a semantic lookup", async () => {
		const { cache, events } = await migrated();
		await cache.set(
			request("How do I reset my password?"),
			{ answer: "a" },
			{ semantic: false },
		);

		expect(
			await cache.get(request("forgot my password, what now?")),
		).toBeNull();
		expect(events.at(-1)).toMatchObject({ result: "miss" });
		expect(events.at(-1)).not.toHaveProperty("similarity");
	});

	it("should warn once and skip writes when exact-only runs on a table that is not migrated", async () => {
		const { ask, calls, errors, table } = await migrated({ semantic: false });
		await pool.query(
			`ALTER TABLE ${table} ALTER COLUMN embedding SET NOT NULL`,
		);
		const fresh = createCache({
			pool,
			embed,
			table,
			awaitStore: true,
			semantic: false,
			onError: (e, stage) => errors.push({ stage, error: e }),
		});

		await fresh.wrap(async () => 1, {
			key: request("How do I reset my password?"),
		});
		await fresh.wrap(async () => 1, {
			key: request("How do I reset my password?"),
		});

		expect(errors).toHaveLength(1);
		expect(String(errors[0]?.error)).toMatch(/migrate\(\)/);
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(0);
		await ask("x");
		expect(calls()).toBe(1);
	});

	it("should reject an invalid threshold on a call", async () => {
		const { cache } = await migrated();
		await expect(cache.get(request("x"), { threshold: 2 })).rejects.toThrow(
			/threshold/,
		);
	});
});

describe("expiry", () => {
	it("should not answer from an expired entry, and cache the fresh answer again", async () => {
		const { ask, calls, events, table } = await migrated({ ttl: "1h" });

		await ask("How do I reset my password?");
		// Expired by hand: a short real TTL also expired the refreshed entry on a slow CI runner.
		await pool.query(
			`UPDATE ${table} SET expires_at = now() - interval '1 second'`,
		);
		await ask("How do I reset my password?");
		await ask("How do I reset my password?");

		expect(calls()).toBe(2);
		expect(events.map((e) => e.result)).toEqual(["miss", "miss", "exact_hit"]);
	});
});

describe("what is not cached", () => {
	it("should bypass the cache when the last message is not from the user", async () => {
		const { cache, events } = await migrated();
		const key = request("x", {
			messages: [{ role: "assistant", content: "Sure," }],
		});
		const fn = vi.fn(async () => ({ answer: "a" }));

		await cache.wrap(fn, { key });
		await cache.wrap(fn, { key });

		expect(fn).toHaveBeenCalledTimes(2);
		expect(events.map((e) => e.result)).toEqual(["bypass", "bypass"]);
	});

	it("should not store a response the caller rejects", async () => {
		const { cache } = await migrated();
		const key = request("How do I reset my password?");
		const fn = vi.fn(async () => ({ answer: "a", tool_calls: [{}] }));

		await cache.wrap(fn, { key, shouldStore: (r) => !r.tool_calls });
		await cache.wrap(fn, { key, shouldStore: (r) => !r.tool_calls });

		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("should propagate a model error and store nothing", async () => {
		const { cache, ask, calls } = await migrated();
		const key = request("How do I reset my password?");

		await expect(
			cache.wrap(() => Promise.reject(new Error("rate limited")), { key }),
		).rejects.toThrow("rate limited");
		await ask("How do I reset my password?");

		expect(calls()).toBe(1);
	});

	it("should store one row when the same miss runs concurrently", async () => {
		const { ask, table } = await migrated();

		await Promise.all([
			ask("cancel my order"),
			ask("cancel my order"),
			ask("cancel my order"),
		]);

		const { rows } = await pool.query(
			`SELECT count(*)::int AS n FROM ${table}`,
		);
		expect(rows[0].n).toBe(1);
	});
});

describe("failing open", () => {
	it("should call the model and report the error when Postgres is unreachable", async () => {
		const down = new pg.Pool({
			host: "127.0.0.1",
			port: 1,
			connectionTimeoutMillis: 500,
		});
		const { ask, calls, errors, events } = setup({ pool: down });

		const answer = await ask("How do I reset my password?");

		expect(answer.answer).toBe("answer to How do I reset my password?");
		expect(calls()).toBe(1);
		expect(errors.map((e) => e.stage)).toEqual(["setup"]);
		expect(events.map((e) => e.result)).toEqual(["miss"]);
		await down.end();
	});

	it("should call the model when the key cannot be built, instead of failing the call", async () => {
		const { cache, events } = await migrated();
		const fn = vi.fn(async () => ({ answer: "fresh" }));

		await expect(
			cache.wrap(fn, { key: request("x", { params: { big: 10n } }) }),
		).resolves.toEqual({ answer: "fresh" });

		expect(fn).toHaveBeenCalledTimes(1);
		expect(events.at(-1)?.result).toBe("bypass");
	});

	it("should report why a key could not be built", async () => {
		const { cache, errors } = await migrated();

		await cache.wrap(async () => 1, {
			key: request("x", { params: { when: new Map() } }),
		});

		expect(errors.map((e) => e.stage)).toEqual(["key"]);
		expect(String(errors[0]?.error)).toMatch(/Map/);
	});

	it("should call the model and report it when the table was never migrated", async () => {
		const { ask, calls, errors } = setup();

		await ask("How do I reset my password?");

		expect(calls()).toBe(1);
		expect(String(errors[0]?.error)).toMatch(/run migrate\(\)/);
	});

	it("should call the model and skip storing when the embedder fails", async () => {
		const { ask, calls, errors, events } = await migrated({
			embed: () => Promise.reject(new Error("embed down")),
		});

		await ask("How do I reset my password?");
		await ask("How do I reset my password?");

		expect(calls()).toBe(2);
		expect(errors.map((e) => e.stage)).toEqual(["embed", "embed"]);
		expect(events.map((e) => e.result)).toEqual(["miss", "miss"]);
	});

	it("should give up on a slow embedder and abort it", async () => {
		let signal: AbortSignal | undefined;
		const slow: CacheOptions["embed"] = (_, options) => {
			signal = options.signal;
			return new Promise(() => {});
		};
		const { ask, calls, errors } = await migrated({
			embed: slow,
			embedTimeoutMs: 50,
		});

		const started = performance.now();
		await ask("How do I reset my password?");

		expect(performance.now() - started).toBeLessThan(500);
		expect(calls()).toBe(1);
		expect(errors[0]?.error).toBeInstanceOf(TimeoutError);
		expect(signal?.aborted).toBe(true);
	});

	it("should reject an embedding whose size does not match the table", async () => {
		const { ask, calls, errors } = await migrated({
			embed: async () => [1, 0],
		});

		await ask("How do I reset my password?");

		expect(calls()).toBe(1);
		expect(errors[0]?.stage).toBe("embed");
		expect(String(errors[0]?.error)).toMatch(/2 dimensions.*3/);
	});

	it("should keep working when the error hook itself throws", async () => {
		const { ask, calls } = setup({
			onError: () => {
				throw new Error("bad hook");
			},
		});

		await expect(ask("How do I reset my password?")).resolves.toBeDefined();
		expect(calls()).toBe(1);
	});

	it("should recover once the table exists, without restarting", async () => {
		const { ask, calls, table, events } = setup();

		await ask("How do I reset my password?");
		await migrate(pool, { table, dimensions: 3 });
		await ask("How do I reset my password?");
		await ask("How do I reset my password?");

		expect(calls()).toBe(2);
		expect(events.at(-1)?.result).toBe("exact_hit");
	});
});

describe("flush", () => {
	it("should wait for background stores and hit counts", async () => {
		const { ask, cache, table } = await migrated({ awaitStore: false });

		await ask("How do I reset my password?");
		await cache.flush();
		await ask("How do I reset my password?");
		await cache.flush();

		const { rows } = await pool.query(`SELECT hits FROM ${table}`);
		expect(rows).toEqual([{ hits: 1 }]);
	});
});

describe("shadow mode", () => {
	async function shadowed(options: Partial<CacheOptions> = {}) {
		const shadows: ShadowEvent[] = [];
		const s = await migrated({
			shadow: true,
			onShadow: (e) => shadows.push(e),
			...options,
		});
		return { ...s, shadows };
	}

	it("should always call the model and report what an exact hit would have served", async () => {
		const { ask, calls, events, shadows, table } = await shadowed();

		const first = await ask("How do I reset my password?");
		const second = await ask("How do I reset my password?");

		expect(calls()).toBe(2);
		expect(second).not.toEqual(first);
		expect(events.map((e) => [e.result, e.shadow])).toEqual([
			["miss", true],
			["exact_hit", true],
		]);
		expect(shadows).toEqual([
			{
				namespace: "default",
				result: "exact_hit",
				similarity: 1,
				cached: first,
				fresh: second,
			},
		]);
		const { rows } = await pool.query(`SELECT hits FROM ${table}`);
		expect(rows).toEqual([{ hits: 0 }]);
	});

	it("should report a semantic hit it would have served", async () => {
		const { ask, calls, shadows } = await shadowed();

		await ask("How do I reset my password?");
		await ask("forgot my password, what now?");

		expect(calls()).toBe(2);
		expect(shadows[0]).toMatchObject({ result: "semantic_hit" });
		expect(shadows[0]?.similarity).toBeGreaterThan(0.97);
	});

	it("should store misses, so turning shadow off afterwards serves them", async () => {
		const { ask, table } = await shadowed();
		await ask("How do I reset my password?");

		const live = createCache({ pool, embed, table, awaitStore: true });
		const fn = vi.fn(async () => ({ answer: "fresh" }));
		await live.wrap(fn, { key: request("How do I reset my password?") });

		expect(fn).not.toHaveBeenCalled();
	});

	it("should apply shadow per call, in both directions", async () => {
		const { cache, ask } = await migrated();
		await ask("How do I reset my password?");
		const fn = vi.fn(async () => ({ answer: "fresh" }));

		await cache.wrap(fn, {
			key: request("How do I reset my password?"),
			shadow: true,
		});
		expect(fn).toHaveBeenCalledTimes(1);

		const shadowCache = await shadowed();
		await shadowCache.ask("cancel my order");
		const served = vi.fn(async () => ({ answer: "fresh" }));
		await shadowCache.cache.wrap(served, {
			key: request("cancel my order"),
			shadow: false,
		});
		expect(served).not.toHaveBeenCalled();
		expect(shadowCache.calls()).toBe(1);
	});

	it("should not report a shadow hit for an answer that would not be stored", async () => {
		const { cache, shadows } = await shadowed();
		const key = request("How do I reset my password?");
		await cache.wrap(async () => ({ answer: "a" }), { key });

		await cache.wrap(async () => ({ answer: "b", tool_calls: [{}] }), {
			key,
			shouldStore: (r) => !("tool_calls" in r),
		});

		expect(shadows).toEqual([]);
	});

	it("should keep working when the shadow hook throws", async () => {
		const { ask, calls } = await shadowed({
			onShadow: () => {
				throw new Error("bad hook");
			},
		});

		await ask("How do I reset my password?");
		await expect(ask("How do I reset my password?")).resolves.toBeDefined();
		expect(calls()).toBe(2);
	});

	it("should return null from get in shadow mode, and flag bypasses", async () => {
		const { ask, cache, events } = await shadowed();
		await ask("How do I reset my password?");

		expect(await cache.get(request("How do I reset my password?"))).toBeNull();
		await cache.wrap(async () => 1, {
			key: request("x", {
				messages: [{ role: "assistant", content: "Sure," }],
			}),
		});
		expect(events.at(-1)).toMatchObject({ result: "bypass", shadow: true });
	});
});

describe("lookup handle", () => {
	it("should store later through the handle, reusing the embedding from the lookup", async () => {
		let embeds = 0;
		const counting: CacheOptions["embed"] = async (text) => {
			embeds++;
			return embed(text);
		};
		const { cache } = await migrated({ embed: counting });

		const first = await cache.lookup(request("How do I reset my password?"));
		expect(first.hit).toBeNull();
		first.store({ answer: "streamed" }, { usage: { input: 5, output: 7 } });
		await cache.flush();

		const second = await cache.lookup(request("How do I reset my password?"));
		expect(second.hit).toMatchObject({
			result: "exact_hit",
			response: { answer: "streamed" },
		});
		expect(embeds).toBe(1);
	});

	it("should make store a no-op on a hit, a bypass and a failed setup", async () => {
		const { cache, table } = await migrated();
		const bypass = await cache.lookup(
			request("x", { messages: [{ role: "assistant", content: "Sure," }] }),
		);
		bypass.store({ answer: "no" });

		const down = new pg.Pool({
			host: "127.0.0.1",
			port: 1,
			connectionTimeoutMillis: 500,
		});
		const broken = createCache({ pool: down, embed, table, onError: () => {} });
		(await broken.lookup(request("How do I reset my password?"))).store({
			answer: "no",
		});
		await broken.flush();
		await down.end();

		await cache.flush();
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(0);
	});
});

describe("get and set", () => {
	it("should read back what set stored", async () => {
		const { cache } = await migrated();
		const key = request("How do I reset my password?");

		await cache.set(key, { answer: "manual" });

		expect(await cache.get(key)).toEqual({
			response: { answer: "manual" },
			result: "exact_hit",
			similarity: 1,
		});
		expect(
			await cache.get(request("forgot my password, what now?")),
		).toMatchObject({ result: "semantic_hit" });
		expect(await cache.get(key, { namespace: "other" })).toBeNull();
	});
});

describe("options", () => {
	it.each([
		[{ threshold: 0 }, /threshold/],
		[{ threshold: 1.1 }, /threshold/],
		[{ lookupTimeoutMs: 0 }, /lookupTimeoutMs/],
		[{ embedTimeoutMs: -1 }, /embedTimeoutMs/],
		[{ table: "Bad Name" }, /table/],
		[{ table: "" }, /table/],
		[{ ttl: "soon" as never }, /ttl/],
	])("should reject %j", (options, message) => {
		expect(() => createCache({ pool, embed, ...options })).toThrow(message);
	});

	it("should reject an empty namespace", async () => {
		const { cache } = await migrated();
		await expect(
			cache.wrap(async () => 1, { key: request("x"), namespace: "" }),
		).rejects.toThrow(/namespace/);
	});
});
