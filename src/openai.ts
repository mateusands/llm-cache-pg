// Types only: the published bundle must never require("openai").
import type OpenAI from "openai";
import type { APIPromise } from "openai/core/api-promise";
import type { Stream } from "openai/core/streaming";
import type {
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { Cache, CallOptions, Embedder } from "./cache.ts";
import { override, without } from "./provider.ts";

type RequestOptions = OpenAI.RequestOptions;

export interface OpenAIEmbedderOptions {
	client: Pick<OpenAI, "embeddings">;
	/** For example `text-embedding-3-small`. */
	model: string;
	/** Shortens the embedding, for models that support it. Must match migrate(). */
	dimensions?: number;
}

export function openaiEmbedder(options: OpenAIEmbedderOptions): Embedder {
	return async (text, { signal }) => {
		const response = await options.client.embeddings.create(
			{
				model: options.model,
				input: text,
				encoding_format: "float",
				...(options.dimensions ? { dimensions: options.dimensions } : {}),
			},
			{ signal },
		);
		const embedding = response.data[0]?.embedding;
		if (!embedding) throw new Error("Embeddings API returned no data");
		return embedding;
	};
}

/**
 * `chat.completions.create` as the wrapper exposes it: a cached answer is a plain Promise, so
 * `.withResponse()` and `.asResponse()` are not available on non-streaming calls.
 */
export interface CachedCompletionsCreate {
	(
		body: ChatCompletionCreateParamsNonStreaming,
		options?: RequestOptions,
	): Promise<ChatCompletion>;
	(
		body: ChatCompletionCreateParamsStreaming,
		options?: RequestOptions,
	): APIPromise<Stream<ChatCompletionChunk>>;
	(
		body: ChatCompletionCreateParamsBase,
		options?: RequestOptions,
	): Promise<Stream<ChatCompletionChunk> | ChatCompletion>;
}

export type CachedOpenAI<T extends OpenAI> = Omit<T, "chat"> & {
	chat: Omit<T["chat"], "completions"> & {
		completions: Omit<T["chat"]["completions"], "create"> & {
			create: CachedCompletionsCreate;
		};
	};
};

// Request fields that never change the answer, so they stay out of the cache key. Anything not
// listed here is part of the key, which keeps new SDK fields from causing false hits.
const NON_SEMANTIC = new Set([
	"metadata",
	"prompt_cache_key",
	"prompt_cache_options",
	"prompt_cache_retention",
	"safety_identifier",
	"service_tier",
	"store",
	"stream_options",
	"user",
]);

function bypasses(body: ChatCompletionCreateParamsBase): boolean {
	return (
		Boolean(body.stream) ||
		(body.n ?? 1) > 1 ||
		Boolean(body.audio) ||
		Boolean(body.modalities?.includes("audio"))
	);
}

function isPlainAnswer(response: ChatCompletion): boolean {
	return response.choices.every(
		(c) =>
			c.finish_reason === "stop" &&
			!c.message.tool_calls?.length &&
			!c.message.function_call,
	);
}

/**
 * Wraps an OpenAI client so non-streaming `chat.completions.create` calls go through `cache`.
 * Streaming, `n > 1` and audio requests, and every other method, reach the SDK untouched.
 */
export function withCache<T extends OpenAI>(
	client: T,
	cache: Cache,
	options: CallOptions = {},
): CachedOpenAI<T> {
	const completions = client.chat.completions;
	const original = completions.create.bind(completions) as (
		body: ChatCompletionCreateParamsBase,
		options?: RequestOptions,
	) => APIPromise<ChatCompletion | Stream<ChatCompletionChunk>>;

	const create = (
		body: ChatCompletionCreateParamsBase,
		requestOptions?: RequestOptions,
	) => {
		if (bypasses(body)) return original(body, requestOptions);
		const { model, messages, ...rest } = body;
		const params = without(rest, NON_SEMANTIC);
		return cache.wrap(
			() => original(body, requestOptions) as Promise<ChatCompletion>,
			{
				...options,
				key: { model, messages, params },
				shouldStore: isPlainAnswer,
				usage: (r) => ({
					input: r.usage?.prompt_tokens,
					output: r.usage?.completion_tokens,
				}),
			},
		);
	};

	const chat = override(
		client.chat,
		"completions",
		override(completions, "create", create),
	);
	return override(client, "chat", chat) as unknown as CachedOpenAI<T>;
}
