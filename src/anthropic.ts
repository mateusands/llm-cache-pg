import type Anthropic from "@anthropic-ai/sdk";
import type { APIPromise } from "@anthropic-ai/sdk/core/api-promise";
// The one runtime import: cached streams are replayed as the SDK's own Stream class.
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import type {
	Message,
	MessageCreateParamsBase,
	MessageCreateParamsNonStreaming,
	MessageCreateParamsStreaming,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { Cache, CallOptions } from "./cache.ts";
import type { KeyInput } from "./key.ts";
import { override, tap, without } from "./provider.ts";

type RequestOptions = Anthropic.RequestOptions;

/**
 * `messages.create` as the wrapper exposes it: results are plain Promises, so `.withResponse()`
 * and `.asResponse()` are not available. A cached stream is a real SDK `Stream`.
 */
export interface CachedMessagesCreate {
	(
		body: MessageCreateParamsNonStreaming,
		options?: RequestOptions,
	): Promise<Message>;
	(
		body: MessageCreateParamsStreaming,
		options?: RequestOptions,
	): Promise<Stream<RawMessageStreamEvent>>;
	(
		body: MessageCreateParamsBase,
		options?: RequestOptions,
	): Promise<Stream<RawMessageStreamEvent> | Message>;
}

export type CachedAnthropic<T extends Anthropic> = Omit<T, "messages"> & {
	messages: Omit<T["messages"], "create"> & { create: CachedMessagesCreate };
};

// Request fields that never change the answer, so they stay out of the cache key. Anything not
// listed here is part of the key, which keeps new SDK fields from causing false hits.
const NON_SEMANTIC = new Set([
	"cache_control",
	"inference_geo",
	"metadata",
	"service_tier",
	"user_profile_id",
	"workspace_id",
]);

const COMPLETE = new Set(["end_turn", "stop_sequence"]);

function isPlainAnswer(response: Message): boolean {
	return (
		COMPLETE.has(response.stop_reason ?? "") &&
		response.content.length > 0 &&
		!response.content.some((block) => block.type === "tool_use")
	);
}

/** Input tokens including prompt-cache reads and writes, which `input_tokens` leaves out. */
function inputTokens(response: Message): number {
	const u = response.usage;
	return (
		u.input_tokens +
		(u.cache_creation_input_tokens ?? 0) +
		(u.cache_read_input_tokens ?? 0)
	);
}

/** Builds the final message from stream events; null until message_stop, or if not all text. */
function assembler() {
	let message: Message | undefined;
	let stopped = false;
	let plainText = true;
	const texts: string[] = [];
	return {
		add(event: RawMessageStreamEvent): void {
			switch (event.type) {
				case "message_start":
					message = { ...event.message, content: [] };
					break;
				case "content_block_start":
					if (event.content_block.type === "text") texts[event.index] = "";
					else plainText = false;
					break;
				case "content_block_delta":
					if (event.delta.type === "text_delta")
						texts[event.index] = (texts[event.index] ?? "") + event.delta.text;
					else plainText = false;
					break;
				case "message_delta":
					if (!message) break;
					message.stop_reason = event.delta.stop_reason;
					message.stop_sequence = event.delta.stop_sequence;
					// Delta usage is cumulative; fields it leaves null or absent keep their start values.
					message.usage = {
						...message.usage,
						...Object.fromEntries(
							Object.entries(event.usage).filter(
								([, v]) => typeof v === "number",
							),
						),
					};
					break;
				case "message_stop":
					stopped = true;
					break;
			}
		},
		result(): Message | null {
			if (!message || !stopped || !plainText) return null;
			return {
				...message,
				content: texts.map((text) => ({ type: "text", text, citations: null })),
			};
		},
	};
}

/** The event sequence MessageStream expects, for a finished all-text message. */
async function* replayEvents(
	message: Message,
): AsyncGenerator<RawMessageStreamEvent> {
	yield {
		type: "message_start",
		message: {
			...message,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { ...message.usage, output_tokens: 0 },
		},
	};
	for (const [index, block] of message.content.entries()) {
		if (block.type !== "text") continue;
		yield {
			type: "content_block_start",
			index,
			content_block: { type: "text", text: "", citations: null },
		};
		yield {
			type: "content_block_delta",
			index,
			delta: { type: "text_delta", text: block.text },
		};
		yield { type: "content_block_stop", index };
	}
	yield {
		type: "message_delta",
		delta: {
			stop_reason: message.stop_reason,
			stop_sequence: message.stop_sequence,
			container: null,
			stop_details: null,
		},
		usage: {
			output_tokens: message.usage.output_tokens,
			input_tokens: null,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			output_tokens_details: null,
			server_tool_use: null,
		},
	};
	yield { type: "message_stop" };
}

/**
 * Wraps an Anthropic client so non-streaming `messages.create` calls go through `cache`.
 * Streaming (including `messages.stream()`) and every other method reach the SDK untouched.
 */
export function withCache<T extends Anthropic>(
	client: T,
	cache: Cache,
	options: CallOptions = {},
): CachedAnthropic<T> {
	const messages = client.messages;
	const original = messages.create.bind(messages) as (
		body: MessageCreateParamsBase,
		options?: RequestOptions,
	) => APIPromise<Message | Stream<RawMessageStreamEvent>>;

	const create = (
		body: MessageCreateParamsBase,
		requestOptions?: RequestOptions,
	) => {
		const { model, messages: history, ...rest } = body;
		if (body.stream) {
			return createStream(body, requestOptions, {
				model,
				messages: history,
				params: without(rest, NON_SEMANTIC),
			});
		}
		return cache.wrap(
			() => original(body, requestOptions) as Promise<Message>,
			{
				...options,
				key: { model, messages: history, params: without(rest, NON_SEMANTIC) },
				shouldStore: isPlainAnswer,
				usage: (r) => ({
					input: inputTokens(r),
					output: r.usage.output_tokens,
				}),
			},
		);
	};

	async function createStream(
		body: MessageCreateParamsBase,
		requestOptions: RequestOptions | undefined,
		key: KeyInput,
	): Promise<Stream<RawMessageStreamEvent>> {
		const handle = await cache.lookup<Message>(key, options);
		if (handle.hit) {
			const message = handle.hit.response;
			return new Stream(
				() => replayEvents(message),
				new AbortController(),
				client,
			);
		}
		const source = (await original(
			body,
			requestOptions,
		)) as Stream<RawMessageStreamEvent>;
		const assembled = assembler();
		const iterate = () =>
			tap(source, source.controller.signal, assembled.add, () => {
				const message = assembled.result();
				if (message && isPlainAnswer(message)) {
					handle.store(message, {
						usage: {
							input: inputTokens(message),
							output: message.usage.output_tokens,
						},
					});
				}
			});
		// Same controller as the SDK's stream, so abort() still cancels the request.
		return new Stream(iterate, source.controller, client);
	}

	return override(
		client,
		"messages",
		override(messages, "create", create),
	) as unknown as CachedAnthropic<T>;
}
