// Types only: the published bundle must never require("@anthropic-ai/sdk").
import type Anthropic from "@anthropic-ai/sdk";
import type { APIPromise } from "@anthropic-ai/sdk/core/api-promise";
import type { Stream } from "@anthropic-ai/sdk/core/streaming";
import type {
	Message,
	MessageCreateParamsBase,
	MessageCreateParamsNonStreaming,
	MessageCreateParamsStreaming,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { Cache, CallOptions } from "./cache.ts";
import { override, without } from "./provider.ts";

type RequestOptions = Anthropic.RequestOptions;

/**
 * `messages.create` as the wrapper exposes it: a cached answer is a plain Promise, so
 * `.withResponse()` and `.asResponse()` are not available on non-streaming calls.
 */
export interface CachedMessagesCreate {
	(
		body: MessageCreateParamsNonStreaming,
		options?: RequestOptions,
	): Promise<Message>;
	(
		body: MessageCreateParamsStreaming,
		options?: RequestOptions,
	): APIPromise<Stream<RawMessageStreamEvent>>;
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
		if (body.stream) return original(body, requestOptions);
		const { model, messages: history, ...rest } = body;
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

	return override(
		client,
		"messages",
		override(messages, "create", create),
	) as unknown as CachedAnthropic<T>;
}
