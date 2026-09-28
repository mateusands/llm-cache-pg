/*
 * Contract: a streamed answer is passed through untouched and stored only once it has ended
 * normally; a cached one is replayed as a real SDK Stream that the SDK's own accumulator turns
 * into the same message. Aborted, failed, truncated or tool-calling streams are never stored.
 */
import type OpenAI from "openai";
import { Stream } from "openai/core/streaming";
import { ChatCompletionStream } from "openai/lib/ChatCompletionStream";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { describe, expect, it, vi } from "vitest";
import { createCache } from "../../src/cache.ts";
import { migrate } from "../../src/migrate.ts";
import { withCache } from "../../src/openai.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();
const base = {
	id: "chatcmpl-s",
	object: "chat.completion.chunk" as const,
	created: 1,
	model: "gpt-test",
};

function chunks(
	options: { finish?: string; toolCall?: boolean; usage?: boolean } = {},
): ChatCompletionChunk[] {
	const list = [
		{
			...base,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "" },
					finish_reason: null,
				},
			],
		},
		{
			...base,
			choices: [
				{ index: 0, delta: { content: "Click " }, finish_reason: null },
			],
		},
		options.toolCall
			? {
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "t",
										type: "function",
										function: { name: "f", arguments: "{}" },
									},
								],
							},
							finish_reason: null,
						},
					],
				}
			: {
					...base,
					choices: [
						{
							index: 0,
							delta: { content: "'Forgot password'." },
							finish_reason: null,
						},
					],
				},
		{
			...base,
			choices: [
				{ index: 0, delta: {}, finish_reason: options.finish ?? "stop" },
			],
		},
	];
	if (options.usage)
		list.push({
			...base,
			choices: [],
			usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
		} as never);
	return list as ChatCompletionChunk[];
}

/** A real SDK Stream. Like the SDK's own, it ends quietly when its controller is aborted. */
function sdkStream(
	items: ChatCompletionChunk[],
	failAt?: number,
): Stream<ChatCompletionChunk> {
	const controller = new AbortController();
	return new Stream(async function* () {
		for (const [i, item] of items.entries()) {
			if (controller.signal.aborted) return;
			if (i === failAt) throw new Error("connection reset");
			yield item;
		}
	}, controller);
}

async function setup(
	make: () => Stream<ChatCompletionChunk> = () => sdkStream(chunks()),
) {
	const streams: Stream<ChatCompletionChunk>[] = [];
	const create = vi.fn(async (body: { stream?: boolean }) => {
		if (!body.stream)
			return {
				id: "c",
				object: "chat.completion",
				created: 1,
				model: "gpt-test",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: { role: "assistant", content: "plain", refusal: null },
					},
				],
			};
		const s = make();
		streams.push(s);
		return s;
	});
	const client = { chat: { completions: { create } } } as unknown as OpenAI;
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({ pool, table, embed: async () => [1, 0, 0] });
	return { create, streams, cache, table, ai: withCache(client, cache) };
}

const body = {
	model: "gpt-test",
	messages: [{ role: "user" as const, content: "How do I reset my password?" }],
	stream: true as const,
};

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of stream) out.push(item);
	return out;
}

/** The message the SDK's own accumulator builds from a stream. */
async function accumulate(stream: Stream<ChatCompletionChunk>) {
	return ChatCompletionStream.fromReadableStream(
		stream.toReadableStream(),
	).finalChatCompletion();
}

describe("withCache for OpenAI, streaming", () => {
	it("should pass the model's chunks through unchanged on a miss", async () => {
		const { ai } = await setup();
		expect(await drain(await ai.chat.completions.create(body))).toEqual(
			chunks(),
		);
	});

	it("should replay a finished stream from the cache as an SDK Stream with the same message", async () => {
		const { ai, cache, create } = await setup();
		const original = await accumulate(sdkStream(chunks()));

		await drain(await ai.chat.completions.create(body));
		await cache.flush();
		const replay = await ai.chat.completions.create(body);

		expect(replay).toBeInstanceOf(Stream);
		expect(create).toHaveBeenCalledTimes(1);
		const replayed = await accumulate(replay);
		expect(replayed.choices[0]?.message.content).toBe(
			"Click 'Forgot password'.",
		);
		expect(replayed.choices[0]?.message).toEqual(original.choices[0]?.message);
		expect(replayed.choices[0]?.finish_reason).toBe("stop");
	});

	it("should replay the usage chunk when the request asks for it, and store the token counts", async () => {
		const { ai, cache, table } = await setup(() =>
			sdkStream(chunks({ usage: true })),
		);
		const withUsage = { ...body, stream_options: { include_usage: true } };

		await drain(await ai.chat.completions.create(withUsage));
		await cache.flush();
		const replayed = await drain(await ai.chat.completions.create(withUsage));

		expect(replayed.at(-1)).toMatchObject({
			choices: [],
			usage: { prompt_tokens: 12, completion_tokens: 5 },
		});
		const { rows } = await pool.query(
			`SELECT tokens_in, tokens_out FROM ${table}`,
		);
		expect(rows).toEqual([{ tokens_in: 12, tokens_out: 5 }]);
	});

	it("should not store a stream the caller stopped reading", async () => {
		const { ai, cache, create } = await setup();

		for await (const _ of await ai.chat.completions.create(body)) break;
		await cache.flush();
		await drain(await ai.chat.completions.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should not store an aborted stream, which the SDK ends without an error", async () => {
		const { ai, cache, create, streams } = await setup();

		const stream = await ai.chat.completions.create(body);
		expect(stream.controller).toBe(streams[0]?.controller);
		const seen: unknown[] = [];
		for await (const chunk of stream) {
			seen.push(chunk);
			stream.controller.abort();
		}
		await cache.flush();
		await drain(await ai.chat.completions.create(body));

		expect(seen).toHaveLength(1);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should not store a stream that ended without a finish reason", async () => {
		const { ai, cache, create } = await setup(() =>
			sdkStream(chunks().slice(0, 3)),
		);

		await drain(await ai.chat.completions.create(body));
		await cache.flush();
		await drain(await ai.chat.completions.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should stop replaying a cached stream once it is aborted", async () => {
		const { ai, cache } = await setup();
		await drain(await ai.chat.completions.create(body));
		await cache.flush();

		const replay = await ai.chat.completions.create(body);
		const seen: unknown[] = [];
		for await (const chunk of replay) {
			seen.push(chunk);
			replay.controller.abort();
		}

		expect(seen).toHaveLength(1);
	});

	it("should pass a mid-stream error to the caller and store nothing", async () => {
		const { ai, cache, create } = await setup(() => sdkStream(chunks(), 2));

		await expect(drain(await ai.chat.completions.create(body))).rejects.toThrow(
			"connection reset",
		);
		await cache.flush();
		await drain(await ai.chat.completions.create(body)).catch(() => {});

		expect(create).toHaveBeenCalledTimes(2);
	});

	it.each([
		["tool calls", { toolCall: true, finish: "tool_calls" }],
		["a truncated answer", { finish: "length" }],
	])("should not store a stream with %s", async (_, options) => {
		const { ai, cache, create } = await setup(() => sdkStream(chunks(options)));

		await drain(await ai.chat.completions.create(body));
		await cache.flush();
		await drain(await ai.chat.completions.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should keep streamed and plain answers apart", async () => {
		const { ai, cache, create } = await setup();
		const { stream: _, ...plain } = body;

		await ai.chat.completions.create(plain);
		await cache.flush();
		await drain(await ai.chat.completions.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});
});
