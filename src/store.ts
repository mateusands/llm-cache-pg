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
}

export interface NewEntry {
	namespace: string;
	key: CacheKey;
	embedding: readonly number[];
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
			const { rows } = await client.query<{ id: string; response: unknown }>(
				`SELECT id, response FROM ${config.table}
				 WHERE namespace = $1 AND model = $2 AND key_version = $3 AND params_hash = $4
				   AND prompt_hash = $5 AND ${LIVE}`,
				[namespace, key.model, KEY_VERSION, key.paramsHash, key.promptHash],
			);
			await client.query("COMMIT");
			const row = rows[0];
			return row ? { id: row.id, response: row.response, similarity: 1 } : null;
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
			const { rows } = await client.query<{
				id: string;
				response: unknown;
				similarity: number;
			}>(
				`SELECT id, response, 1 - (embedding <=> $1::vector) AS similarity FROM ${config.table}
				 WHERE namespace = $2 AND model = $3 AND key_version = $4 AND params_hash = $5 AND ${LIVE}
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
					toVector(entry.embedding),
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
