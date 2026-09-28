import { type CacheKey, KEY_VERSION } from "./key.ts";
import { type Pool, withClient } from "./pg.ts";

export interface StoreConfig {
	table: string;
	/** Whether pgvector supports `hnsw.iterative_scan` (0.8.0+); setting it on older versions is an error. */
	iterativeScan: boolean;
	/** Per-step budget for lookups, enforced on the client and the server. */
	lookupTimeoutMs: number;
	/** Budget for background writes, which can wait on index maintenance. */
	writeTimeoutMs: number;
}

export interface Match {
	id: string;
	response: unknown;
	/** Cosine similarity, 1 for an exact match. */
	similarity: number;
	tokensIn: number | null;
	tokensOut: number | null;
}

export interface NewEntry {
	namespace: string;
	key: CacheKey;
	/** Null for entries written with semantic lookups off. */
	embedding: readonly number[] | null;
	response: unknown;
	tokensIn?: number | null;
	tokensOut?: number | null;
	ttlMs: number | null;
}

/** The statements that open a lookup transaction. */
export function lookupPreamble(
	config: Pick<StoreConfig, "iterativeScan" | "lookupTimeoutMs">,
): string {
	const statements = [
		"BEGIN READ ONLY",
		// Server side too: a client-side timeout alone leaves the query running on the server.
		`SET LOCAL statement_timeout = ${config.lookupTimeoutMs}`,
	];
	// Without it, filtering by partition after the HNSW scan can discard every candidate.
	if (config.iterativeScan)
		statements.push("SET LOCAL hnsw.iterative_scan = relaxed_order");
	return statements.join("; ");
}

function toVector(values: readonly number[]): string {
	return `[${values.join(",")}]`;
}

const LIVE = "(expires_at IS NULL OR expires_at > now())";
const MATCH_COLUMNS = `id, response, tokens_in AS "tokensIn", tokens_out AS "tokensOut"`;

export async function findExact(
	pool: Pool,
	config: StoreConfig,
	namespace: string,
	key: CacheKey,
): Promise<Match | null> {
	return withClient(
		pool,
		async (client) => {
			await client.query(lookupPreamble({ ...config, iterativeScan: false }));
			const { rows } = await client.query<Match>(
				`SELECT ${MATCH_COLUMNS}, 1::float8 AS similarity FROM ${config.table}
				 WHERE namespace = $1 AND model = $2 AND key_version = $3 AND params_hash = $4
				   AND prompt_hash = $5 AND ${LIVE}`,
				[namespace, key.model, KEY_VERSION, key.paramsHash, key.promptHash],
			);
			await client.query("COMMIT");
			return rows[0] ?? null;
		},
		config.lookupTimeoutMs,
	);
}

/** The closest live entry in the same partition, whatever its similarity; the caller applies the threshold. */
export async function findNearest(
	pool: Pool,
	config: StoreConfig,
	namespace: string,
	key: CacheKey,
	embedding: readonly number[],
): Promise<Match | null> {
	return withClient(
		pool,
		async (client) => {
			await client.query(lookupPreamble(config));
			// relaxed_order can return a slightly farther row first; the threshold still applies to it.
			const { rows } = await client.query<Match>(
				`SELECT ${MATCH_COLUMNS}, 1 - (embedding <=> $1::vector) AS similarity FROM ${config.table}
				 WHERE namespace = $2 AND model = $3 AND key_version = $4 AND params_hash = $5 AND ${LIVE}
				   AND embedding IS NOT NULL
				 ORDER BY embedding <=> $1::vector
				 LIMIT 1`,
				[
					toVector(embedding),
					namespace,
					key.model,
					KEY_VERSION,
					key.paramsHash,
				],
			);
			await client.query("COMMIT");
			return rows[0] ?? null;
		},
		config.lookupTimeoutMs,
	);
}

/**
 * Stores an answer. A live entry with the same key is kept as is, so concurrent misses don't fight;
 * an expired one is replaced, since reads already ignore it.
 */
export async function insertEntry(
	pool: Pool,
	config: StoreConfig,
	entry: NewEntry,
): Promise<void> {
	const t = config.table;
	await withClient(
		pool,
		(client) =>
			client.query(
				`INSERT INTO ${t} AS t (namespace, model, key_version, params_hash, prompt_hash, prompt_text,
				                        embedding, response, tokens_in, tokens_out, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10,
				         now() + $11::bigint * interval '1 millisecond')
				 ON CONFLICT (namespace, model, key_version, params_hash, prompt_hash) DO UPDATE SET
				   prompt_text = EXCLUDED.prompt_text, embedding = EXCLUDED.embedding,
				   response = EXCLUDED.response, tokens_in = EXCLUDED.tokens_in,
				   tokens_out = EXCLUDED.tokens_out, expires_at = EXCLUDED.expires_at,
				   hits = 0, last_hit_at = NULL, created_at = now()
				 WHERE t.expires_at IS NOT NULL AND t.expires_at <= now()`,
				[
					entry.namespace,
					entry.key.model,
					KEY_VERSION,
					entry.key.paramsHash,
					entry.key.promptHash,
					entry.key.text,
					entry.embedding && toVector(entry.embedding),
					JSON.stringify(entry.response),
					entry.tokensIn ?? null,
					entry.tokensOut ?? null,
					entry.ttlMs,
				],
			),
		config.writeTimeoutMs,
	);
}

export async function recordHit(
	pool: Pool,
	config: StoreConfig,
	id: string,
): Promise<void> {
	await withClient(
		pool,
		(client) =>
			client.query(
				`UPDATE ${config.table} SET hits = hits + 1, last_hit_at = now() WHERE id = $1`,
				[id],
			),
		config.writeTimeoutMs,
	);
}

/** Deletes expired entries `batchSize` at a time, so no single statement holds locks for long. */
export async function deleteExpired(
	pool: Pool,
	table: string,
	batchSize: number,
): Promise<number> {
	let total = 0;
	for (;;) {
		const { rowCount } = await pool.query(
			`DELETE FROM ${table} WHERE id IN (
			   SELECT id FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= now() LIMIT $1)`,
			[batchSize],
		);
		total += rowCount ?? 0;
		if ((rowCount ?? 0) < batchSize) return total;
	}
}

export interface EntryFilter {
	namespace?: string;
	model?: string;
	key?: CacheKey;
}

/** The WHERE clause for a filter, shared so a count always matches what a delete would remove. */
function matching(filter: EntryFilter): { where: string; values: unknown[] } {
	const conditions: string[] = [];
	const values: unknown[] = [];
	const add = (column: string, value: unknown) => {
		values.push(value);
		conditions.push(`${column} = $${values.length}`);
	};
	if (filter.namespace !== undefined) add("namespace", filter.namespace);
	if (filter.model !== undefined) add("model", filter.model);
	if (filter.key) {
		add("model", filter.key.model);
		add("key_version", KEY_VERSION);
		add("params_hash", filter.key.paramsHash);
		add("prompt_hash", filter.key.promptHash);
	}
	if (conditions.length === 0)
		throw new Error("An entry filter needs at least one condition");
	return { where: conditions.join(" AND "), values };
}

/** Deletes entries matching every given filter. */
export async function deleteMatching(
	pool: Pool,
	table: string,
	filter: EntryFilter,
): Promise<number> {
	const { where, values } = matching(filter);
	const { rowCount } = await pool.query(
		`DELETE FROM ${table} WHERE ${where}`,
		values,
	);
	return rowCount ?? 0;
}

/** How many entries deleteMatching would remove for the same filter. */
export async function countMatching(
	pool: Pool,
	table: string,
	filter: EntryFilter,
): Promise<number> {
	const { where, values } = matching(filter);
	const { rows } = await pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
		values,
	);
	return rows[0]?.n ?? 0;
}

export interface TableStats {
	entries: number;
	expired: number;
	withoutEmbedding: number;
	hits: number;
	totalBytes: number;
	indexBytes: number;
	/** 1 for a table migrated before the migrations table existed. */
	schemaVersion: number;
	namespaces: { name: string; entries: number }[];
	models: { name: string; entries: number }[];
}

/** Exact counts (count(*), not planner estimates) for the admin CLI. */
export async function tableStats(
	pool: Pool,
	table: string,
): Promise<TableStats> {
	const totals = await pool.query<{
		entries: number;
		expired: number;
		without_embedding: number;
		hits: number;
		total_bytes: number;
		index_bytes: number;
	}>(
		`SELECT count(*)::int AS entries,
		        count(*) FILTER (WHERE expires_at <= now())::int AS expired,
		        count(*) FILTER (WHERE embedding IS NULL)::int AS without_embedding,
		        coalesce(sum(hits), 0)::float8 AS hits,
		        pg_total_relation_size(to_regclass($1))::float8 AS total_bytes,
		        pg_indexes_size(to_regclass($1))::float8 AS index_bytes
		   FROM ${table}`,
		[table],
	);
	const row = totals.rows[0];
	let schemaVersion = 1;
	const hasMigrations = await pool.query<{ ok: boolean }>(
		"SELECT to_regclass($1) IS NOT NULL AS ok",
		[`${table}_migrations`],
	);
	if (hasMigrations.rows[0]?.ok) {
		const v = await pool.query<{ v: number | null }>(
			`SELECT max(version) AS v FROM ${table}_migrations`,
		);
		schemaVersion = v.rows[0]?.v ?? 1;
	}
	const top = async (column: "namespace" | "model") =>
		(
			await pool.query<{ name: string; entries: number }>(
				`SELECT ${column} AS name, count(*)::int AS entries FROM ${table} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
			)
		).rows;
	return {
		entries: row?.entries ?? 0,
		expired: row?.expired ?? 0,
		withoutEmbedding: row?.without_embedding ?? 0,
		hits: row?.hits ?? 0,
		totalBytes: row?.total_bytes ?? 0,
		indexBytes: row?.index_bytes ?? 0,
		schemaVersion,
		namespaces: await top("namespace"),
		models: await top("model"),
	};
}
