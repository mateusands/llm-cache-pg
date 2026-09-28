import { type Pool, type PoolClient, withClient } from "./pg.ts";

export const DEFAULT_TABLE = "llm_cache_entries";
export const DEFAULT_DIMENSIONS = 1536;

// Leaves room for the longest derived name ("_migrations") within Postgres' 63-byte identifier limit.
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,47}$/;
// HNSW indexes on `vector` support at most 2000 dimensions.
const MAX_DIMENSIONS = 2000;
const SCHEMA_VERSION = 1;

export interface MigrationOptions {
	/** Lowercase identifier, at most 48 characters. Default `llm_cache_entries`. */
	table?: string;
	/** Embedding size, 1 to 2000. Must match the embedder. Default 1536. */
	dimensions?: number;
}

export interface MigrationResult {
	pgvectorVersion: string;
	/** Non-fatal problems, such as a pgvector too old for filtered semantic lookups. */
	warnings: string[];
}

/** Validates the options and fills in defaults. Throws on an unsafe table name or bad dimensions. */
export function resolveMigrationOptions(
	options: MigrationOptions = {},
): Required<MigrationOptions> {
	const table = options.table ?? DEFAULT_TABLE;
	const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
	if (!TABLE_NAME.test(table)) {
		throw new Error(
			`Invalid table name ${JSON.stringify(table)}: use lowercase letters, digits and _, max 48 chars`,
		);
	}
	if (
		!Number.isInteger(dimensions) ||
		dimensions < 1 ||
		dimensions > MAX_DIMENSIONS
	) {
		throw new Error(
			`Invalid dimensions ${dimensions}: must be an integer from 1 to ${MAX_DIMENSIONS}`,
		);
	}
	return { table, dimensions };
}

/** The schema as plain SQL, for teams that apply migrations with their own tool. Idempotent. */
export function renderMigrationSql(options?: MigrationOptions): string {
	const { table: t, dimensions } = resolveMigrationOptions(options);
	return `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ${t} (
  id           bigserial PRIMARY KEY,
  namespace    text        NOT NULL DEFAULT 'default',
  model        text        NOT NULL,
  key_version  smallint    NOT NULL,
  params_hash  text        NOT NULL,
  prompt_hash  text        NOT NULL,
  prompt_text  text        NOT NULL,
  embedding    vector(${dimensions}) NOT NULL,
  response     jsonb       NOT NULL,
  tokens_in    int,
  tokens_out   int,
  hits         int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_hit_at  timestamptz,
  expires_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ${t}_key_uidx ON ${t} (namespace, model, key_version, params_hash, prompt_hash);
CREATE INDEX IF NOT EXISTS ${t}_partition_idx ON ${t} (namespace, model, key_version, params_hash);
CREATE INDEX IF NOT EXISTS ${t}_embedding_idx ON ${t} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ${t}_expires_idx ON ${t} (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${t}_migrations (
  version     int PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ${t}_migrations (version) VALUES (${SCHEMA_VERSION}) ON CONFLICT DO NOTHING;
`;
}

/** True when pgvector has `hnsw.iterative_scan`, which needs 0.8.0 or newer. */
export function supportsIterativeScan(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > 0 || minor >= 8;
}

export interface TableInfo {
	pgvectorVersion: string;
	dimensions: number;
}

/** Reads the installed pgvector version and the table's vector size. Throws if the table is missing. */
export async function inspectTable(
	db: Pick<PoolClient, "query">,
	table: string,
): Promise<TableInfo> {
	const { rows } = await db.query<{
		version: string | null;
		type: string | null;
	}>(
		`SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS version,
		        (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
		          WHERE attrelid = to_regclass($1) AND attname = 'embedding') AS type`,
		[table],
	);
	const row = rows[0];
	const dimensions = Number(row?.type?.match(/^vector\((\d+)\)$/)?.[1]);
	if (!row?.version || !dimensions) {
		throw new Error(
			`Table ${table} or the vector extension is missing; run migrate() first`,
		);
	}
	return { pgvectorVersion: row.version, dimensions };
}

/**
 * Creates the cache table and indexes if they don't exist. Safe to run on every startup and from
 * several processes at once. Throws if the table exists with a different vector size.
 */
export async function migrate(
	pool: Pool,
	options?: MigrationOptions,
): Promise<MigrationResult> {
	const { table, dimensions } = resolveMigrationOptions(options);
	const sql = renderMigrationSql({ table, dimensions });

	return withClient(pool, async (client) => {
		await client.query("BEGIN");
		// One lock for every table: CREATE EXTENSION races across tables, not just within one.
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('llm-cache-pg:migrate'))",
		);
		await client.query(sql);

		const info = await inspectTable(client, table);
		if (info.dimensions !== dimensions) {
			throw new Error(
				`Table ${table} stores ${info.dimensions} dimensions, but ${dimensions} were configured`,
			);
		}
		const warnings = supportsIterativeScan(info.pgvectorVersion)
			? []
			: [
					`pgvector ${info.pgvectorVersion} has no iterative index scans; semantic lookups may miss entries in busy namespaces. Upgrade to 0.8.0 or newer.`,
				];
		await client.query("COMMIT");
		return { pgvectorVersion: info.pgvectorVersion, warnings };
	});
}
