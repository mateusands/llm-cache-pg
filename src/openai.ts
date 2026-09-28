import type OpenAI from "openai";
import type { APIPromise } from "openai/core/api-promise";
// The one runtime import: cached streams are replayed as the SDK's own Stream class.
import { Stream } from "openai/core/streaming";
import type {
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { Cache, CallOptions, Embedder } from "./cache.ts";
import type { KeyInput } from "./key.ts";
import { override, tap, untilAborted, without } from "./provider.ts";

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
 * `chat.completions.create` as the wrapper exposes it: results are plain Promises, so
 * `.withResponse()` and `.asResponse()` are not available. A cached stream is a real SDK `Stream`.
 */
export interface CachedCompletionsCreate {
	(
		body: ChatCompletionCreateParamsNonStreaming,
		options?: RequestOptions,
	): Promise<ChatCompletion>;
	(
		body: ChatCompletionCreateParamsStreaming,
		options?: RequestOptions,
	): Promise<Stream<ChatCompletionChunk>>;
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
		(body.n ?? 1) > 1 ||
		Boolean(body.audio) ||
		Boolean(body.modalities?.includes("audio"))
	);
}

function isPlainAnswer(response: ChatCompletion): boolean {
	// every() is true on an empty array, so an answer with no choices has to be ruled out first.
	return (
		response.choices.length > 0 &&
		response.choices.every(
			(c) =>
				c.finish_reason === "stop" &&
				!c.message.tool_calls?.length &&
				!c.message.function_call,
		)
	);
}

/** Builds the final completion from stream chunks; null while incomplete or if not plain text. */
function assembler() {
	let head: Pick<ChatCompletionChunk, "id" | "created" | "model"> | undefined;
	let usage: ChatCompletion["usage"];
	let plainText = true;
	const choices = new Map<
		number,
		{ content: string; finish: ChatCompletionChunk.Choice["finish_reason"] }
	>();
	return {
		add(chunk: ChatCompletionChunk): void {
			head ??= { id: chunk.id, created: chunk.created, model: chunk.model };
			if (chunk.usage) usage = chunk.usage;
			for (const c of chunk.choices) {
				const entry = choices.get(c.index) ?? { content: "", finish: null };
				choices.set(c.index, entry);
				if (
					c.delta.tool_calls?.length ||
					c.delta.function_call ||
					c.delta.refusal
				)
					plainText = false;
				if (c.delta.content) entry.content += c.delta.content;
				if (c.finish_reason) entry.finish = c.finish_reason;
			}
		},
		result(): ChatCompletion | null {
			const list = [...choices.entries()].sort(([a], [b]) => a - b);
			if (
				!head ||
				!plainText ||
				list.length === 0 ||
				list.some(([, c]) => !c.finish)
			)
				return null;
			return {
				...head,
				object: "chat.completion",
				choices: list.map(([index, c]) => ({
					index,
					finish_reason: c.finish as ChatCompletion.Choice["finish_reason"],
					logprobs: null,
					message: { role: "assistant", content: c.content, refusal: null },
				})),
				...(usage ? { usage } : {}),
			};
		},
	};
}

/** The shortest chunk sequence the SDK accepts for a finished completion. */
async function* replayChunks(
	completion: ChatCompletion,
	includeUsage: boolean,
): AsyncGenerator<ChatCompletionChunk> {
	const head = {
		id: completion.id,
		object: "chat.completion.chunk" as const,
		created: completion.created,
		model: completion.model,
		// With include_usage, every chunk carries `usage`, null until the last one.
		...(includeUsage ? { usage: null } : {}),
	};
	const each = (delta: ChatCompletionChunk.Choice.Delta, finish: boolean) => ({
		...head,
		choices: completion.choices.map((c) => ({
			index: c.index,
			delta,
			finish_reason: finish ? c.finish_reason : null,
			logprobs: null,
		})),
	});
	yield each({ role: "assistant", content: "" }, false);
	yield {
		...head,
		choices: completion.choices.map((c) => ({
			index: c.index,
			delta: { content: c.message.content ?? "" },
			finish_reason: null,
			logprobs: null,
		})),
	};
	yield each({}, true);
	if (includeUsage && completion.usage)
		yield { ...head, choices: [], usage: completion.usage };
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
		if (body.stream)
			return createStream(body, requestOptions, { model, messages, params });
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

	async function createStream(
		body: ChatCompletionCreateParamsBase,
		requestOptions: RequestOptions | undefined,
		key: KeyInput,
	): Promise<Stream<ChatCompletionChunk>> {
		const handle = await cache.lookup<ChatCompletion>(key, options);
		if (handle.hit) {
			const completion = handle.hit.response;
			const includeUsage = Boolean(body.stream_options?.include_usage);
			const controller = new AbortController();
			return new Stream(
				() =>
					untilAborted(
						replayChunks(completion, includeUsage),
						controller.signal,
					),
				controller,
				client,
			);
		}
		const source = (await original(
			body,
			requestOptions,
		)) as Stream<ChatCompletionChunk>;
		const assembled = assembler();
		const iterate = () =>
			tap(source, source.controller.signal, assembled.add, () => {
				const completion = assembled.result();
				if (completion && isPlainAnswer(completion)) {
					handle.store(completion, {
						usage: {
							input: completion.usage?.prompt_tokens,
							output: completion.usage?.completion_tokens,
						},
					});
				}
			});
		// Same controller as the SDK's stream, so abort() still cancels the request.
		return new Stream(iterate, source.controller, client);
	}

	const chat = override(
		client.chat,
		"completions",
		override(completions, "create", create),
	);
	return override(client, "chat", chat) as unknown as CachedOpenAI<T>;
}
