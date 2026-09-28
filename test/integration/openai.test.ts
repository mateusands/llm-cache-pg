/*
 * Contract: withCache intercepts only chat.completions.create, and only for requests that return
 * one plain text answer. Everything else reaches the SDK untouched.
 */
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createCache } from "../../src/cache.ts";
import { migrate } from "../../src/migrate.ts";
import { openaiEmbedder, withCache } from "../../src/openai.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();

function completion(text: string, extra: Record<string, unknown> = {}) {
	return {
		id: "chatcmpl-1",
		object: "chat.completion",
		created: 1,
		model: "gpt-test",
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: text, refusal: null },
			},
		],
		usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
		...extra,
	};
}

function fakeClient(answer = completion("Click 'Forgot password'.")) {
	const create = vi.fn(async (_body: unknown, _options?: unknown) => answer);
	const embeddings = vi.fn(async (_body: unknown, _options?: unknown) => ({
		data: [{ embedding: [1, 0, 0], index: 0, object: "embedding" }],
	}));
	const other = vi.fn(async () => "listed");
	const client = {
		chat: { completions: { create, list: other } },
		embeddings: { create: embeddings },
		models: { list: other },
	};
	return { client: client as unknown as OpenAI, create, embeddings, other };
}

async function setup(answer?: ReturnType<typeof completion>) {
	const fake = fakeClient(answer);
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({
		pool,
		table,
		awaitStore: true,
		embed: openaiEmbedder({ client: fake.client, model: "e" }),
	});
	return {
		...fake,
		table,
		ai: withCache(fake.client, cache, { namespace: "tenant" }),
	};
}

const body = {
	model: "gpt-test",
	messages: [{ role: "user" as const, content: "How do I reset my password?" }],
	temperature: 0,
};

describe("withCache for OpenAI", () => {
	it("should answer a repeated request from the cache", async () => {
		const { ai, create } = await setup();

		const first = await ai.chat.completions.create(body);
		const second = await ai.chat.completions.create(body);

		expect(second).toEqual(first);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should pass the request options through to the SDK", async () => {
		const { ai, create } = await setup();
		const signal = new AbortController().signal;

		await ai.chat.completions.create(body, { signal });

		expect(create).toHaveBeenCalledWith(body, { signal });
	});

	it("should store token usage with the entry", async () => {
		const { ai, table } = await setup();

		await ai.chat.completions.create(body);

		const { rows } = await pool.query(
			`SELECT tokens_in, tokens_out FROM ${table}`,
		);
		expect(rows).toEqual([{ tokens_in: 12, tokens_out: 5 }]);
	});

	it("should ignore fields that don't change the answer", async () => {
		const { ai, create } = await setup();

		await ai.chat.completions.create({
			...body,
			user: "u1",
			metadata: { a: "1" },
			store: true,
		});
		await ai.chat.completions.create({
			...body,
			user: "u2",
			service_tier: "flex",
			prompt_cache_key: "k",
		});

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should treat any other field as part of the key", async () => {
		const { ai, create } = await setup();

		await ai.chat.completions.create(body);
		await ai.chat.completions.create({ ...body, seed: 7 });
		await ai.chat.completions.create({
			...body,
			response_format: { type: "json_object" },
		});

		expect(create).toHaveBeenCalledTimes(3);
	});

	it.each([
		["streaming", { stream: true }],
		["several choices", { n: 2 }],
		["audio output", { modalities: ["text", "audio"] }],
	])("should bypass the cache for %s", async (_, extra) => {
		const { ai, create, embeddings } = await setup();

		await ai.chat.completions.create({ ...body, ...extra } as never);
		await ai.chat.completions.create({ ...body, ...extra } as never);

		expect(create).toHaveBeenCalledTimes(2);
		expect(embeddings).not.toHaveBeenCalled();
	});

	it.each([
		[
			"tool calls",
			completion("", {
				choices: [
					{
						index: 0,
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: null,
							tool_calls: [{ id: "t" }],
						},
					},
				],
			}),
		],
		[
			"a truncated answer",
			completion("", {
				choices: [
					{
						index: 0,
						finish_reason: "length",
						message: { role: "assistant", content: "Click" },
					},
				],
			}),
		],
	])("should not store a response with %s", async (_, answer) => {
		const { ai, create } = await setup(answer);

		await ai.chat.completions.create(body);
		await ai.chat.completions.create(body);

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should leave every other method untouched", async () => {
		const { ai, client, other } = await setup();

		await ai.models.list();
		await ai.chat.completions.list();

		expect(other).toHaveBeenCalledTimes(2);
		expect(ai.embeddings).toBe(client.embeddings);
	});
});

describe("openaiEmbedder", () => {
	it("should call the embeddings API with the model, dimensions and abort signal", async () => {
		const { client, embeddings } = fakeClient();
		const signal = new AbortController().signal;

		const vector = await openaiEmbedder({
			client,
			model: "text-embedding-3-small",
			dimensions: 3,
		})("hi", { signal });

		expect(vector).toEqual([1, 0, 0]);
		expect(embeddings).toHaveBeenCalledWith(
			{
				model: "text-embedding-3-small",
				input: "hi",
				dimensions: 3,
				encoding_format: "float",
			},
			{ signal },
		);
	});
});
