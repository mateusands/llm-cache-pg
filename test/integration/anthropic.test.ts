/*
 * Contract: withCache intercepts only messages.create, and only for non-streaming requests whose
 * answer is complete text. Everything else reaches the SDK untouched.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { withCache } from "../../src/anthropic.ts";
import { createCache } from "../../src/cache.ts";
import { migrate } from "../../src/migrate.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();

function message(extra: Record<string, unknown> = {}) {
	return {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-test",
		content: [
			{ type: "text", text: "Click 'Forgot password'.", citations: null },
		],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 10,
			output_tokens: 6,
			cache_creation_input_tokens: 100,
			cache_read_input_tokens: 1000,
		},
		...extra,
	};
}

async function setup(answer = message()) {
	const create = vi.fn(async (_body: unknown, _options?: unknown) => answer);
	const other = vi.fn(async () => "counted");
	const client = {
		messages: { create, countTokens: other },
		models: { list: other },
	} as unknown as Anthropic;
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({
		pool,
		table,
		awaitStore: true,
		embed: async () => [1, 0, 0],
	});
	return {
		client,
		create,
		other,
		table,
		ai: withCache(client, cache, { namespace: "tenant" }),
	};
}

const body = {
	model: "claude-test",
	max_tokens: 256,
	system: "You are a support bot.",
	messages: [{ role: "user" as const, content: "How do I reset my password?" }],
};

describe("withCache for Anthropic", () => {
	it("should answer a repeated request from the cache", async () => {
		const { ai, create } = await setup();

		const first = await ai.messages.create(body);
		const second = await ai.messages.create(body);

		expect(second).toEqual(first);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should pass the request options through to the SDK", async () => {
		const { ai, create } = await setup();
		const signal = new AbortController().signal;

		await ai.messages.create(body, { signal });

		expect(create).toHaveBeenCalledWith(body, { signal });
	});

	it("should store input tokens including prompt-cache reads and writes", async () => {
		const { ai, table } = await setup();

		await ai.messages.create(body);

		const { rows } = await pool.query(
			`SELECT tokens_in, tokens_out FROM ${table}`,
		);
		expect(rows).toEqual([{ tokens_in: 1110, tokens_out: 6 }]);
	});

	it("should read text content blocks as the question", async () => {
		const { ai, create } = await setup();
		const blocks = {
			...body,
			messages: [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "How do I reset my password?" },
					],
				},
			],
		};

		await ai.messages.create(blocks);
		await ai.messages.create(blocks);

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should ignore fields that don't change the answer", async () => {
		const { ai, create } = await setup();

		await ai.messages.create({
			...body,
			metadata: { user_id: "u1" },
			service_tier: "auto",
		});
		await ai.messages.create({
			...body,
			metadata: { user_id: "u2" },
			cache_control: { type: "ephemeral" },
		});

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should keep the system prompt and any other field in the key", async () => {
		const { ai, create } = await setup();

		await ai.messages.create(body);
		await ai.messages.create({ ...body, system: "You are a pirate." });
		await ai.messages.create({ ...body, temperature: 1 });
		await ai.messages.create({
			...body,
			thinking: { type: "enabled", budget_tokens: 1024 },
		});

		expect(create).toHaveBeenCalledTimes(4);
	});

	it("should bypass the cache for streaming", async () => {
		const { ai, create } = await setup();

		await ai.messages.create({ ...body, stream: true } as never);
		await ai.messages.create({ ...body, stream: true } as never);

		expect(create).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			"tool use",
			message({
				stop_reason: "tool_use",
				content: [{ type: "tool_use", id: "t", name: "x", input: {} }],
			}),
		],
		["no content blocks", message({ content: [] })],
		["a truncated answer", message({ stop_reason: "max_tokens" })],
		["a refusal", message({ stop_reason: "refusal" })],
	])("should not store a response with %s", async (_, answer) => {
		const { ai, create } = await setup(answer);

		await ai.messages.create(body);
		await ai.messages.create(body);

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should store an answer that ended on a stop sequence", async () => {
		const { ai, create } = await setup(
			message({ stop_reason: "stop_sequence", stop_sequence: "END" }),
		);

		await ai.messages.create(body);
		await ai.messages.create(body);

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("should leave every other method untouched", async () => {
		const { ai, other } = await setup();

		await ai.models.list();
		await ai.messages.countTokens(body);

		expect(other).toHaveBeenCalledTimes(2);
	});
});
