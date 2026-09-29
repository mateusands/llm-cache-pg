import {
	type CacheKey,
	deriveKey,
	type KeyInput,
	tryDeriveKey,
} from "./key.ts";
import {
	inspectTable,
	resolveMigrationOptions,
	supportsIterativeScan,
} from "./migrate.ts";
import { type Pool, TimeoutError, withClient } from "./pg.ts";
import {
	deleteExpired,
	deleteMatching,
	findExact,
	findNearest,
	insertEntry,
	type Match,
	recordHit,
	type StoreConfig,
	type TableStats,
	tableStats,
} from "./store.ts";
import { parseTtl, type Ttl } from "./ttl.ts";

/** Turns text into an embedding. Should stop work when `signal` aborts. */
export type Embedder = (
	text: string,
	options: { signal: AbortSignal },
) => Promise<number[]>;

export type LookupResult = "exact_hit" | "semantic_hit" | "miss" | "bypass";
export type ErrorStage =
	| "setup"
	| "exact"
	| "embed"
	| "semantic"
	| "store"
	| "hit"
	| "key";

export interface LookupEvent {
	result: LookupResult;
	namespace: string;
	/** Best cosine similarity found; absent when no semantic lookup ran. */
	similarity?: number;
	/** Milliseconds per stage that ran; a stage that was skipped is absent. */
	durations: Durations;
	/** Token counts stored with the entry, on a hit (or what a shadow hit would have saved). */
	tokens?: { input: number | null; output: number | null };
	/** True in shadow mode: `result` is what would have happened, and the model was called anyway. */
	shadow?: boolean;
}

export interface ShadowEvent {
	namespace: string;
	/** What would have been served in live mode. */
	result: "exact_hit" | "semantic_hit";
	similarity: number;
	/** The stored answer that would have been served. */
	cached: unknown;
	/** The model's answer, returned to the caller. */
	fresh: unknown;
}

export interface Durations {
	exact?: number;
	embed?: number;
	semantic?: number;
}

export interface CacheOptions {
	pool: Pool;
	embed: Embedder;
	/** Cosine similarity needed for a semantic hit, in (0, 1]. Default 0.92. */
	threshold?: number;
	/** False for exact matches only: no embedding calls and no false hits. Default true. */
	semantic?: boolean;
	/** How long entries live. Default: no expiry. */
	ttl?: Ttl;
	/** Must match the table given to migrate(). Default `llm_cache_entries`. */
	table?: string;
	/** Budget for each database lookup, in ms. Default 200. */
	lookupTimeoutMs?: number;
	/** Budget for the embedding call, in ms. Default 5000. */
	embedTimeoutMs?: number;
	/** Wait for the write on a miss before returning. Default false. */
	awaitStore?: boolean;
	/** Called for every failure inside the cache; never receives prompt or response text. Default: console.warn. */
	onError?: (error: unknown, stage: ErrorStage) => void;
	/** Called once per lookup with its outcome. */
	onLookup?: (event: LookupEvent) => void;
	/**
	 * Look up but never serve: the model is always called and every lookup is flagged `shadow`.
	 * Misses are still stored. Default false.
	 */
	shadow?: boolean;
	/**
	 * Called in shadow mode when a hit would have been served, with both answers to compare.
	 * Unlike every other hook, it receives response content.
	 */
	onShadow?: (event: ShadowEvent) => void;
}

export interface CallOptions {
	/** Tenant or scope; entries are never shared across namespaces. Default `default`. */
	namespace?: string;
	/** Overrides the cache-wide ttl for entries this call writes. */
	ttl?: Ttl;
	/** Overrides the cache-wide threshold for this call. */
	threshold?: number;
	/** Overrides the cache-wide `semantic` setting for this call. */
	semantic?: boolean;
	/** Overrides the cache-wide `shadow` setting for this call. */
	shadow?: boolean;
}

export interface Usage {
	input?: number | undefined;
	output?: number | undefined;
}

export interface WrapOptions<R> extends CallOptions {
	key: KeyInput;
	/** Return false to skip storing a response, such as one with tool calls. */
	shouldStore?: (response: R) => boolean;
	/** Token counts stored with the entry, for savings metrics. */
	usage?: (response: R) => Usage | undefined;
}

export interface CachedResponse<R> {
	response: R;
	result: "exact_hit" | "semantic_hit";
	similarity: number;
}

export interface Cache {
	/** Returns a cached answer for `key`, or calls `fn` and stores what it returns. `R` must be JSON. */
	wrap<R>(fn: () => Promise<R>, options: WrapOptions<R>): Promise<R>;
	/**
	 * Looks up `key` and returns a handle whose `store` saves the answer after a miss, reusing the
	 * lookup's embedding. For responses that only exist later, such as streams.
	 */
	lookup<R>(key: KeyInput, options?: CallOptions): Promise<LookupHandle<R>>;
	/** Looks up without calling anything. Null on a miss, a bypass, an internal failure or in shadow mode. */
	get<R>(
		key: KeyInput,
		options?: CallOptions,
	): Promise<CachedResponse<R> | null>;
	/** Stores `response` for `key`, shadow mode or not. Resolves even if the write fails; the failure goes to onError. */
	set<R>(
		key: KeyInput,
		response: R,
		options?: CallOptions & { usage?: Usage },
	): Promise<void>;
	/** Waits for background writes (stores, hit counts). Call before closing the pool. */
	flush(): Promise<void>;
	/** Deletes expired entries and returns how many. Throws on failure. */
	prune(options?: { batchSize?: number }): Promise<number>;
	/**
	 * Deletes the entries matching every given filter and returns how many. `key` targets one exact
	 * request, in `namespace` (default `default`). Throws without a filter or on failure.
	 */
	invalidate(filter: InvalidateFilter): Promise<number>;
	/** Exact counts, sizes and versions for the table (count(*), so slow on very large tables). Throws on failure. */
	stats(): Promise<CacheStats>;
}

export interface CacheStats extends TableStats {
	table: string;
	pgvectorVersion: string;
}

export interface LookupHandle<R> {
	hit: CachedResponse<R> | null;
	/**
	 * Stores the answer in the background (see `flush`). A no-op after a hit, a bypass, a failed
	 * lookup or a previous call. After a shadow hit it stores nothing and reports to `onShadow`.
	 */
	store(response: R, options?: { usage?: Usage }): void;
}

export interface InvalidateFilter {
	namespace?: string;
	model?: string;
	key?: KeyInput;
}

// Writes run in the background and can wait on HNSW index maintenance.
const WRITE_TIMEOUT_MS = 5000;

function validThreshold(threshold: number): number {
	if (!(threshold > 0 && threshold <= 1))
		throw new Error(`Invalid threshold ${threshold}: must be in (0, 1]`);
	return threshold;
}

function positiveInteger(name: string, value: number): number {
	if (!Number.isInteger(value) || value <= 0)
		throw new Error(`Invalid ${name} ${value}: must be a positive integer`);
	return value;
}

interface Setup {
	config: StoreConfig;
	dimensions: number;
	embeddingOptional: boolean;
}

interface Found<R> {
	hit: CachedResponse<R> | null;
	/** Both set when the entry can be stored after the model answers; null means no embedding. */
	embedding?: number[] | null;
	setup?: Setup;
	/** In shadow mode, what would have been served. */
	shadowHit?: CachedResponse<unknown>;
}

interface Mode {
	threshold: number;
	semantic: boolean;
	shadow: boolean;
}

export function createCache(options: CacheOptions): Cache {
	const { pool, embed } = options;
	const threshold = validThreshold(options.threshold ?? 0.92);
	const semantic = options.semantic ?? true;
	const shadow = options.shadow ?? false;
	const defaultTtlMs = parseTtl(options.ttl);
	const { table } = resolveMigrationOptions({
		...(options.table !== undefined ? { table: options.table } : {}),
	});
	const lookupTimeoutMs = positiveInteger(
		"lookupTimeoutMs",
		options.lookupTimeoutMs ?? 200,
	);
	const embedTimeoutMs = positiveInteger(
		"embedTimeoutMs",
		options.embedTimeoutMs ?? 5000,
	);
	const onError = options.onError ?? defaultOnError;

	function report(error: unknown, stage: ErrorStage): void {
		try {
			onError(error, stage);
		} catch {
			// A broken hook must not turn into a broken request.
		}
	}

	function emit(event: LookupEvent): void {
		try {
			options.onLookup?.(event);
		} catch (error) {
			report(error, "hit");
		}
	}

	const pending = new Set<Promise<void>>();

	function background(write: Promise<void>): void {
		pending.add(write);
		write.finally(() => pending.delete(write));
	}

	let setup: Promise<Setup> | undefined;

	// Read once; a failure is not remembered, so the cache recovers when the table appears.
	function ensureSetup(): Promise<Setup> {
		setup ??= withClient(
			pool,
			(c) => inspectTable(c, table),
			lookupTimeoutMs,
		).then(
			(info) => ({
				dimensions: info.dimensions,
				embeddingOptional: info.embeddingOptional,
				config: {
					table,
					iterativeScan: supportsIterativeScan(info.pgvectorVersion),
					lookupTimeoutMs,
					writeTimeoutMs: WRITE_TIMEOUT_MS,
				},
			}),
			(error) => {
				setup = undefined;
				throw error;
			},
		);
		return setup;
	}

	async function embedText(
		text: string,
		dimensions: number,
	): Promise<number[]> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new TimeoutError(embedTimeoutMs)),
			embedTimeoutMs,
		);
		try {
			// Raced as well as signalled, for embedders that ignore the signal.
			const aborted = new Promise<never>((_, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => reject(controller.signal.reason),
					{ once: true },
				);
			});
			const pending = embed(text, { signal: controller.signal });
			pending.catch(() => {});
			const vector = await Promise.race([pending, aborted]);
			if (vector.length !== dimensions) {
				throw new Error(
					`Embedder returned ${vector.length} dimensions, the table stores ${dimensions}`,
				);
			}
			return vector;
		} finally {
			clearTimeout(timer);
		}
	}

	function resolveMode(call: CallOptions | undefined): Mode {
		return {
			threshold:
				call?.threshold === undefined
					? threshold
					: validThreshold(call.threshold),
			semantic: call?.semantic ?? semantic,
			shadow: call?.shadow ?? shadow,
		};
	}

	const flag = (mode: Mode) => (mode.shadow ? { shadow: true } : {});

	/** The key, or null for a bypass; says why when part of the request cannot be hashed. */
	function keyOf(input: KeyInput): CacheKey | null {
		const { key, error } = tryDeriveKey(input);
		if (error !== undefined) report(error, "key");
		return key;
	}

	/** Reports a shadow hit once the fresh answer exists and would itself have been stored. */
	function reportShadow(
		hit: CachedResponse<unknown>,
		namespace: string,
		fresh: unknown,
	): void {
		try {
			options.onShadow?.({
				namespace,
				result: hit.result,
				similarity: hit.similarity,
				cached: hit.response,
				fresh,
			});
		} catch (error) {
			report(error, "hit");
		}
	}

	let warnedMissingV2 = false;

	/** Whether an entry without an embedding can be stored; warns once on a table that can't. */
	function canStoreWithoutEmbedding(s: Setup): boolean {
		if (s.embeddingOptional) return true;
		if (!warnedMissingV2) {
			warnedMissingV2 = true;
			report(
				new Error(
					`Table ${table} requires embeddings; run migrate() to store entries with semantic off`,
				),
				"setup",
			);
		}
		return false;
	}

	function resolveNamespace(namespace: string | undefined): string {
		const ns = namespace ?? "default";
		if (typeof ns !== "string" || ns.length === 0)
			throw new Error("namespace must be a non-empty string");
		return ns;
	}

	function hitFrom<R>(
		match: Match,
		result: CachedResponse<R>["result"],
		s: Setup,
	): CachedResponse<R> {
		background(
			recordHit(pool, s.config, match.id).catch((error) =>
				report(error, "hit"),
			),
		);
		return {
			response: match.response as R,
			result,
			similarity: match.similarity,
		};
	}

	async function find<R>(
		key: CacheKey,
		namespace: string,
		mode: Mode,
	): Promise<Found<R>> {
		const durations: Durations = {};
		const miss = (similarity?: number) =>
			emit({
				result: "miss",
				namespace,
				durations,
				...flag(mode),
				...(similarity === undefined ? {} : { similarity }),
			});
		const hit = (
			match: Match,
			result: CachedResponse<R>["result"],
			s: Setup,
		): Found<R> => {
			emit({
				result,
				namespace,
				similarity: match.similarity,
				durations,
				tokens: { input: match.tokensIn, output: match.tokensOut },
				...flag(mode),
			});
			// Nothing is served in shadow mode, so the entry's hit count stays as it is.
			if (mode.shadow) {
				return {
					hit: null,
					shadowHit: {
						response: match.response,
						result,
						similarity: match.similarity,
					},
				};
			}
			return { hit: hitFrom<R>(match, result, s) };
		};
		const timed = async <T>(
			stage: keyof Durations,
			work: () => Promise<T>,
		): Promise<T> => {
			const started = performance.now();
			try {
				return await work();
			} finally {
				durations[stage] = performance.now() - started;
			}
		};

		let s: Setup;
		try {
			s = await ensureSetup();
		} catch (error) {
			report(error, "setup");
			miss();
			return { hit: null };
		}

		try {
			const exact = await timed("exact", () =>
				findExact(pool, s.config, namespace, key),
			);
			if (exact) return hit(exact, "exact_hit", s);
		} catch (error) {
			// The database is unhealthy; skip the embedding and the write, both would fail too.
			report(error, "exact");
			miss();
			return { hit: null };
		}

		if (!mode.semantic) {
			miss();
			return canStoreWithoutEmbedding(s)
				? { hit: null, embedding: null, setup: s }
				: { hit: null };
		}

		let embedding: number[];
		try {
			embedding = await timed("embed", () => embedText(key.text, s.dimensions));
		} catch (error) {
			report(error, "embed");
			miss();
			return { hit: null };
		}

		let nearest: Match | null = null;
		try {
			nearest = await timed("semantic", () =>
				findNearest(pool, s.config, namespace, key, embedding),
			);
		} catch (error) {
			report(error, "semantic");
		}
		if (nearest && nearest.similarity >= mode.threshold)
			return hit(nearest, "semantic_hit", s);
		miss(nearest?.similarity);
		return { hit: null, embedding, setup: s };
	}

	async function store(
		s: Setup,
		namespace: string,
		key: CacheKey,
		embedding: number[] | null,
		response: unknown,
		ttl: Ttl | undefined,
		usage: Usage | undefined,
	): Promise<void> {
		try {
			await insertEntry(pool, s.config, {
				namespace,
				key,
				embedding,
				response,
				tokensIn: usage?.input ?? null,
				tokensOut: usage?.output ?? null,
				ttlMs: ttl === undefined ? defaultTtlMs : parseTtl(ttl),
			});
		} catch (error) {
			report(error, "store");
		}
	}

	return {
		async wrap<R>(
			fn: () => Promise<R>,
			wrapOptions: WrapOptions<R>,
		): Promise<R> {
			const namespace = resolveNamespace(wrapOptions.namespace);
			const mode = resolveMode(wrapOptions);
			if (wrapOptions.ttl !== undefined) parseTtl(wrapOptions.ttl);
			const key = keyOf(wrapOptions.key);
			if (!key) {
				emit({ result: "bypass", namespace, durations: {}, ...flag(mode) });
				return fn();
			}

			const found = await find<R>(key, namespace, mode);
			if (found.hit) return found.hit.response;

			const response = await fn();
			const storable = wrapOptions.shouldStore?.(response) ?? true;
			if (found.shadowHit && storable)
				reportShadow(found.shadowHit, namespace, response);
			if (found.setup && found.embedding !== undefined && storable) {
				const write = store(
					found.setup,
					namespace,
					key,
					found.embedding,
					response,
					wrapOptions.ttl,
					wrapOptions.usage?.(response),
				);
				if (options.awaitStore) await write;
				else background(write);
			}
			return response;
		},

		async lookup<R>(
			keyInput: KeyInput,
			callOptions?: CallOptions,
		): Promise<LookupHandle<R>> {
			const namespace = resolveNamespace(callOptions?.namespace);
			const mode = resolveMode(callOptions);
			if (callOptions?.ttl !== undefined) parseTtl(callOptions.ttl);
			const key = keyOf(keyInput);
			if (!key) {
				emit({ result: "bypass", namespace, durations: {}, ...flag(mode) });
				return { hit: null, store: () => {} };
			}
			const found = await find<R>(key, namespace, mode);
			let stored = false;
			return {
				hit: found.hit,
				store(response, storeOptions) {
					if (stored) return;
					stored = true;
					if (found.shadowHit) {
						reportShadow(found.shadowHit, namespace, response);
						return;
					}
					if (!found.setup || found.embedding === undefined) return;
					background(
						store(
							found.setup,
							namespace,
							key,
							found.embedding,
							response,
							callOptions?.ttl,
							storeOptions?.usage,
						),
					);
				},
			};
		},

		async get<R>(
			keyInput: KeyInput,
			callOptions?: CallOptions,
		): Promise<CachedResponse<R> | null> {
			const namespace = resolveNamespace(callOptions?.namespace);
			const mode = resolveMode(callOptions);
			const key = keyOf(keyInput);
			if (!key) {
				emit({ result: "bypass", namespace, durations: {}, ...flag(mode) });
				return null;
			}
			return (await find<R>(key, namespace, mode)).hit;
		},

		async set<R>(
			keyInput: KeyInput,
			response: R,
			callOptions?: CallOptions & { usage?: Usage },
		): Promise<void> {
			const namespace = resolveNamespace(callOptions?.namespace);
			const key = keyOf(keyInput);
			if (!key) return;
			try {
				const s = await ensureSetup();
				let embedding: number[] | null = null;
				if (resolveMode(callOptions).semantic) {
					embedding = await embedText(key.text, s.dimensions);
				} else if (!canStoreWithoutEmbedding(s)) {
					return;
				}
				await store(
					s,
					namespace,
					key,
					embedding,
					response,
					callOptions?.ttl,
					callOptions?.usage,
				);
			} catch (error) {
				report(error, "store");
			}
		},

		async flush(): Promise<void> {
			await Promise.all(pending);
		},

		prune(pruneOptions?: { batchSize?: number }): Promise<number> {
			const batchSize = positiveInteger(
				"batchSize",
				pruneOptions?.batchSize ?? 1000,
			);
			return deleteExpired(pool, table, batchSize);
		},

		async invalidate(filter: InvalidateFilter): Promise<number> {
			if (
				filter.namespace === undefined &&
				filter.model === undefined &&
				!filter.key
			) {
				throw new Error("invalidate() needs a filter: namespace, model or key");
			}
			let key: CacheKey | undefined;
			if (filter.key) {
				key = deriveKey(filter.key) ?? undefined;
				if (!key)
					throw new Error("invalidate() got a key that is never cacheable");
			}
			const namespace = key
				? resolveNamespace(filter.namespace)
				: filter.namespace;
			return deleteMatching(pool, table, {
				...(namespace !== undefined ? { namespace } : {}),
				...(filter.model !== undefined ? { model: filter.model } : {}),
				...(key ? { key } : {}),
			});
		},

		async stats(): Promise<CacheStats> {
			// First, so a missing table gets the "run migrate()" message rather than a SQL error.
			const info = await inspectTable(pool, table);
			return {
				table,
				pgvectorVersion: info.pgvectorVersion,
				...(await tableStats(pool, table)),
			};
		},
	};
}

function defaultOnError(error: unknown, stage: ErrorStage): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[llm-cache-pg] ${stage} failed: ${message}`);
}
