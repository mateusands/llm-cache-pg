/*
 * Contract: same as the OpenAI stream tests. A streamed answer passes through untouched and is
 * stored only after message_stop; a cached one replays as an SDK Stream that MessageStream turns
 * into the same message. Aborted, failed, truncated, tool-using or non-text streams are not stored.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it, vi } from "vitest";
import { withCache } from "../../src/anthropic.ts";
import { createCache } from "../../src/cache.ts";
import { migrate } from "../../src/migrate.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();

function events(
	options: {
		stop?: string;
		block?: "tool_use" | "thinking";
		end?: boolean;
	} = {},
): RawMessageStreamEvent[] {
	const usage = {
		input_tokens: 10,
		output_tokens: 1,
		cache_creation_input_tokens: 100,
		cache_read_input_tokens: 1000,
	};
	const block =
		options.block === "tool_use"
			? { type: "tool_use", id: "t", name: "f", input: {} }
			: options.block === "thinking"
				? { type: "thinking", thinking: "", signature: "" }
				: { type: "text", text: "", citations: null };
	const delta =
		options.block === "tool_use"
			? { type: "input_json_delta", partial_json: "{}" }
			: options.block === "thinking"
				? { type: "thinking_delta", thinking: "hmm" }
				: { type: "text_delta", text: "Click 'Forgot password'." };
	const list = [
		{
			type: "message_start",
			message: {
				id: "msg_s",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		},
		{ type: "content_block_start", index: 0, content_block: block },
		{ type: "content_block_delta", index: 0, delta },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: options.stop ?? "end_turn", stop_sequence: null },
			usage: { output_tokens: 6 },
		},
		{ type: "message_stop" },
	];
	return (
		options.end === false ? list.slice(0, 5) : list
	) as RawMessageStreamEvent[];
}

/** A full event stream for the given blocks, each started empty and then filled by its deltas. */
function streamOf(
	blocks: { start: unknown; deltas: unknown[] }[],
): RawMessageStreamEvent[] {
	const usage = {
		input_tokens: 10,
		output_tokens: 1,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
	return [
		{
			type: "message_start",
			message: {
				id: "msg_b",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		},
		...blocks.flatMap((b, index) => [
			{ type: "content_block_start", index, content_block: b.start },
			...b.deltas.map((delta) => ({
				type: "content_block_delta",
				index,
				delta,
			})),
			{ type: "content_block_stop", index },
		]),
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 9 },
		},
		{ type: "message_stop" },
	] as RawMessageStreamEvent[];
}

const TEXT = {
	start: { type: "text", text: "", citations: null },
	deltas: [{ type: "text_delta", text: "Paris." }],
};
const citation = (text: string, start: number) => ({
	type: "char_location",
	cited_text: text,
	document_index: 0,
	document_title: null,
	start_char_index: start,
	end_char_index: start + text.length,
	file_id: null,
});

/** A real SDK Stream. Like the SDK's own, it ends quietly when its controller is aborted. */
function sdkStream(
	items: RawMessageStreamEvent[],
	failAt?: number,
	signal?: AbortSignal,
): Stream<RawMessageStreamEvent> {
	const controller = new AbortController();
	// The SDK aborts the request when the caller's signal does.
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	return new Stream(async function* () {
		for (const [i, item] of items.entries()) {
			if (controller.signal.aborted) return;
			if (i === failAt) throw new Error("connection reset");
			yield item;
		}
	}, controller);
}

async function setup(
	make: (signal?: AbortSignal) => Stream<RawMessageStreamEvent> = (signal) =>
		sdkStream(events(), undefined, signal),
) {
	const streams: Stream<RawMessageStreamEvent>[] = [];
	// Shaped like the SDK's APIPromise, which MessageStream calls withResponse() on.
	const create = vi.fn((_body: unknown, options?: { signal?: AbortSignal }) => {
		const s = make(options?.signal);
		streams.push(s);
		const response = new Response(null, { headers: { "request-id": "req_1" } });
		return Object.assign(Promise.resolve(s), {
			withResponse: async () => ({ data: s, response, request_id: "req_1" }),
		});
	});
	const client = { messages: { create } } as unknown as Anthropic;
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({ pool, table, embed: async () => [1, 0, 0] });
	return { create, streams, cache, table, ai: withCache(client, cache) };
}

const body = {
	model: "claude-test",
	max_tokens: 256,
	messages: [{ role: "user" as const, content: "How do I reset my password?" }],
	stream: true as const,
};

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of stream) out.push(item);
	return out;
}

const finalMessage = (stream: Stream<RawMessageStreamEvent>) =>
	MessageStream.fromReadableStream(stream.toReadableStream()).finalMessage();

describe("withCache for Anthropic, streaming", () => {
	it("should pass the model's events through unchanged on a miss", async () => {
		const { ai } = await setup();
		expect(await drain(await ai.messages.create(body))).toEqual(events());
	});

	it("should replay a finished stream from the cache as an SDK Stream with the same message", async () => {
		const { ai, cache, create } = await setup();
		const original = await finalMessage(sdkStream(events()));

		await drain(await ai.messages.create(body));
		await cache.flush();
		const replay = await ai.messages.create(body);

		expect(replay).toBeInstanceOf(Stream);
		expect(create).toHaveBeenCalledTimes(1);
		const replayed = await finalMessage(replay);
		expect(replayed.content).toEqual(original.content);
		expect(replayed.stop_reason).toBe("end_turn");
		expect(replayed.usage.output_tokens).toBe(6);
	});

	it("should store input tokens including prompt-cache reads and writes", async () => {
		const { ai, cache, table } = await setup();

		await drain(await ai.messages.create(body));
		await cache.flush();

		const { rows } = await pool.query(
			`SELECT tokens_in, tokens_out FROM ${table}`,
		);
		expect(rows).toEqual([{ tokens_in: 1110, tokens_out: 6 }]);
	});

	it("should not store a stream the caller stopped reading", async () => {
		const { ai, cache, create } = await setup();

		for await (const _ of await ai.messages.create(body)) break;
		await cache.flush();
		await drain(await ai.messages.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should not store an aborted stream, which the SDK ends without an error", async () => {
		const { ai, cache, create, streams } = await setup();

		const stream = await ai.messages.create(body);
		expect(stream.controller).toBe(streams[0]?.controller);
		for await (const _ of stream) stream.controller.abort();
		await cache.flush();
		await drain(await ai.messages.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("should stop replaying a cached stream once it is aborted", async () => {
		const { ai, cache } = await setup();
		await drain(await ai.messages.create(body));
		await cache.flush();

		const replay = await ai.messages.create(body);
		const seen: unknown[] = [];
		for await (const event of replay) {
			seen.push(event);
			replay.controller.abort();
		}

		expect(seen).toHaveLength(1);
	});

	it("should pass a mid-stream error to the caller and store nothing", async () => {
		const { ai, cache, create } = await setup(() => sdkStream(events(), 3));

		await expect(drain(await ai.messages.create(body))).rejects.toThrow(
			"connection reset",
		);
		await cache.flush();
		await drain(await ai.messages.create(body)).catch(() => {});

		expect(create).toHaveBeenCalledTimes(2);
	});

	it.each([
		["no message_stop", { end: false }],
		["tool use", { block: "tool_use", stop: "tool_use" }],
		["a truncated answer", { stop: "max_tokens" }],
	] as const)("should not store a stream with %s", async (_, options) => {
		const { ai, cache, create } = await setup(() => sdkStream(events(options)));

		await drain(await ai.messages.create(body));
		await cache.flush();
		await drain(await ai.messages.create(body));

		expect(create).toHaveBeenCalledTimes(2);
	});

	describe("messages.stream()", () => {
		const { stream: _, ...helperBody } = body;

		it("should serve the helper from the cache, with the same final message", async () => {
			const { ai, cache, create } = await setup();

			const first = await ai.messages.stream(helperBody).finalMessage();
			await cache.flush();
			const second = await ai.messages.stream(helperBody).finalMessage();

			expect(create).toHaveBeenCalledTimes(1);
			expect(second.content).toEqual(first.content);
			expect(second.stop_reason).toBe(first.stop_reason);
		});

		it("should emit the helper's text events on a cached answer", async () => {
			const { ai, cache } = await setup();
			await ai.messages.stream(helperBody).finalMessage();
			await cache.flush();

			const texts: string[] = [];
			await ai.messages
				.stream(helperBody)
				.on("text", (text) => texts.push(text))
				.finalMessage();

			expect(texts.join("")).toBe("Click 'Forgot password'.");
		});

		it("should keep the request id on a miss and have none on a cached answer", async () => {
			const { ai, cache } = await setup();

			const miss = ai.messages.stream(helperBody);
			await miss.finalMessage();
			await cache.flush();
			const hit = ai.messages.stream(helperBody);
			await hit.finalMessage();

			expect(miss.request_id).toBe("req_1");
			expect(hit.request_id).toBeFalsy();
		});

		it("should stop a cached answer when the helper is aborted", async () => {
			const { ai, cache } = await setup();
			await ai.messages.stream(helperBody).finalMessage();
			await cache.flush();

			const helper = ai.messages.stream(helperBody);
			const completed = vi.fn();
			helper.on("message", completed);
			helper.on("streamEvent", () => helper.abort());

			await expect(helper.finalMessage()).rejects.toThrow();
			expect(completed).not.toHaveBeenCalled();
		});
	});

	describe("content other than plain text", () => {
		it.each([
			[
				"thinking with its signature",
				[
					{
						start: { type: "thinking", thinking: "", signature: "" },
						deltas: [
							{ type: "thinking_delta", thinking: "The user wants " },
							{ type: "thinking_delta", thinking: "a capital." },
							{ type: "signature_delta", signature: "sig-partial" },
							{ type: "signature_delta", signature: "sig-final" },
						],
					},
					TEXT,
				],
			],
			[
				"redacted thinking",
				[
					{ start: { type: "redacted_thinking", data: "opaque" }, deltas: [] },
					TEXT,
				],
			],
			[
				"text with citations",
				[
					{
						start: { type: "text", text: "", citations: null },
						deltas: [
							{ type: "text_delta", text: "Paris is the capital of France." },
							{ type: "citations_delta", citation: citation("Paris", 0) },
							{ type: "citations_delta", citation: citation("France", 24) },
						],
					},
				],
			],
			[
				"text that starts with an empty citation list",
				[{ ...TEXT, start: { type: "text", text: "", citations: [] } }],
			],
		])("should store and replay %s, block for block", async (_, blocks) => {
			const { ai, cache, create } = await setup(() =>
				sdkStream(streamOf(blocks)),
			);
			const original = await finalMessage(sdkStream(streamOf(blocks)));

			await drain(await ai.messages.create(body));
			await cache.flush();
			const replayed = await finalMessage(await ai.messages.create(body));

			expect(create).toHaveBeenCalledTimes(1);
			expect(replayed.content).toEqual(original.content);
		});

		it("should still not store a stream with server tool blocks", async () => {
			const blocks = [
				{
					start: {
						type: "server_tool_use",
						id: "s",
						name: "web_search",
						input: {},
					},
					deltas: [],
				},
				TEXT,
			];
			const { ai, cache, create } = await setup(() =>
				sdkStream(streamOf(blocks)),
			);

			await drain(await ai.messages.create(body));
			await cache.flush();
			await drain(await ai.messages.create(body));

			expect(create).toHaveBeenCalledTimes(2);
		});
	});
});
