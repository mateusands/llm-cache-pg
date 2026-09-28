import type { ErrorStage, LookupEvent } from "./cache.ts";
import { resolveMigrationOptions } from "./migrate.ts";
import { type Pool, withClient } from "./pg.ts";

/*
 * Structural types for the parts of a Prometheus client the hooks use. `@prometheus-io/client` and
 * the older `prom-client` both fit, so neither becomes a dependency and users keep the one they run.
 */

type Labels = Record<string, string>;

interface MetricConfig {
	name: string;
	help: string;
	labelNames?: string[];
	// never[] so each client's own Registry[] parameter accepts it; the one value passed is cast.
	registers?: never[];
}

export interface PrometheusClient {
	Counter: new (
		config: MetricConfig,
	) => { inc(labels: Labels, value?: number): void };
	Histogram: new (
		config: MetricConfig & { buckets?: number[] },
	) => { observe(labels: Labels, value: number): void };
	Gauge: new (
		config: MetricConfig & { collect?: () => Promise<void> },
	) => { set(labels: Labels, value: number): void };
	register: PrometheusRegistry;
}

export interface PrometheusRegistry {
	getSingleMetric(name: string): unknown;
}

export interface PrometheusOptions {
	/** The client module: `import * as client from "@prometheus-io/client"` (or "prom-client"). */
	client: PrometheusClient;
	/** Default: the client's global registry. */
	registry?: PrometheusRegistry;
	/** Adds a `namespace` label. Off by default: one series per tenant can overload Prometheus. */
	namespaceLabel?: boolean;
	/** With `pool`, exports `llm_cache_entries` for `table` (default `llm_cache_entries`). */
	pool?: Pool;
	table?: string;
}

export interface PrometheusHooks {
	onLookup(event: LookupEvent): void;
	onError(error: unknown, stage: ErrorStage): void;
}

// The entry count reads Postgres statistics, so a scrape costs one cheap query per table.
const ENTRIES_TIMEOUT_MS = 1000;
// Seconds. Database lookups take well under 5 ms, where the client's default buckets start; the
// upper end covers embedding calls to a remote API.
const DURATION_BUCKETS = [
	0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
const SIMILARITY_BUCKETS = [
	0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.92, 0.94, 0.96, 0.98, 1,
];

// Tables whose entry count each registry reports; one gauge per registry serves them all.
const entrySources = new WeakMap<PrometheusRegistry, Map<string, Pool>>();

/**
 * Metrics for a cache, to spread into `createCache({ ...prometheusHooks(options) })`. Safe to call
 * more than once on the same registry: metrics are shared, not registered twice.
 */
export function prometheusHooks(options: PrometheusOptions): PrometheusHooks {
	const { client } = options;
	const registry = options.registry ?? client.register;
	const registers = [registry] as never[];

	function metric<M>(name: string, create: () => M): M {
		return (registry.getSingleMetric(name) as M | undefined) ?? create();
	}

	const requestLabels = options.namespaceLabel
		? ["result", "namespace"]
		: ["result"];
	const requests = metric(
		"llm_cache_requests_total",
		() =>
			new client.Counter({
				name: "llm_cache_requests_total",
				help: "Cache lookups by result.",
				labelNames: requestLabels,
				registers,
			}),
	);
	const registeredLabels = (requests as { labelNames?: string[] }).labelNames;
	if (registeredLabels && registeredLabels.length !== requestLabels.length) {
		throw new Error(
			"Every prometheusHooks() call on one registry must use the same namespaceLabel",
		);
	}
	const tokensSaved = metric(
		"llm_cache_tokens_saved_total",
		() =>
			new client.Counter({
				name: "llm_cache_tokens_saved_total",
				help: "Model tokens not spent because of cache hits.",
				labelNames: ["direction"],
				registers,
			}),
	);
	const duration = metric(
		"llm_cache_lookup_duration_seconds",
		() =>
			new client.Histogram({
				name: "llm_cache_lookup_duration_seconds",
				help: "Time spent per lookup stage.",
				labelNames: ["stage"],
				buckets: DURATION_BUCKETS,
				registers,
			}),
	);
	const similarity = metric(
		"llm_cache_similarity",
		() =>
			new client.Histogram({
				name: "llm_cache_similarity",
				help: "Best cosine similarity found by semantic lookups.",
				buckets: SIMILARITY_BUCKETS,
				registers,
			}),
	);
	const errors = metric(
		"llm_cache_errors_total",
		() =>
			new client.Counter({
				name: "llm_cache_errors_total",
				help: "Failures inside the cache, by stage. Requests still reached the model.",
				labelNames: ["stage"],
				registers,
			}),
	);

	if (options.pool) {
		const { table } = resolveMigrationOptions(
			options.table === undefined ? {} : { table: options.table },
		);
		let sources = entrySources.get(registry);
		if (!sources) {
			const tables = new Map<string, Pool>();
			sources = tables;
			entrySources.set(registry, tables);
			const gauge = metric(
				"llm_cache_entries",
				() =>
					new client.Gauge({
						name: "llm_cache_entries",
						help: "Rows in the cache table, from Postgres statistics (includes expired rows not yet pruned).",
						labelNames: ["table"],
						registers,
						collect: async () => {
							for (const [t, pool] of tables) {
								try {
									const { rows } = await withClient(
										pool,
										(c) =>
											c.query<{ n: number }>(
												"SELECT n_live_tup::float8 AS n FROM pg_stat_user_tables WHERE relid = to_regclass($1)",
												[t],
											),
										ENTRIES_TIMEOUT_MS,
									);
									gauge.set({ table: t }, rows[0]?.n ?? 0);
								} catch {
									// Keep the last value; a scrape must not fail because the database did.
								}
							}
						},
					}),
			);
		}
		sources.set(table, options.pool);
	}

	return {
		onLookup(event) {
			requests.inc(
				options.namespaceLabel
					? { result: event.result, namespace: event.namespace }
					: { result: event.result },
			);
			for (const [stage, ms] of Object.entries(event.durations)) {
				duration.observe({ stage }, ms / 1000);
			}
			if (
				event.durations.semantic !== undefined &&
				event.similarity !== undefined
			) {
				similarity.observe({}, event.similarity);
			}
			if (event.tokens) {
				tokensSaved.inc({ direction: "in" }, event.tokens.input ?? 0);
				tokensSaved.inc({ direction: "out" }, event.tokens.output ?? 0);
			}
		},
		onError(_error, stage) {
			errors.inc({ stage });
		},
	};
}
