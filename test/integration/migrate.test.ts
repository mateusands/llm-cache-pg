/*
 * Contract: migrate() is idempotent, safe to run from several processes at once, and refuses to
 * run against an existing table whose vector size differs from the one configured.
 */
import pg from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { migrate } from "../../src/migrate.ts";
import { iterativeScan, pgvectorVersion, testPool, uniqueTable } from "./db.ts";

const pool = testPool();

async function indexesOf(table: string): Promise<string[]> {
	const { rows } = await pool.query<{ indexname: string }>(
		"SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname",
		[table],
	);
	return rows.map((r) => r.indexname);
}

describe("migrate", () => {
	it("should create the table, its indexes and record the version on an empty database", async () => {
		const table = uniqueTable();
		const result = await migrate(pool, { table });

		expect(await indexesOf(table)).toEqual(
			[
				`${table}_embedding_idx`,
				`${table}_expires_idx`,
				`${table}_key_uidx`,
				`${table}_partition_idx`,
				`${table}_pkey`,
			].sort(),
		);
		const { rows } = await pool.query(
			`SELECT version FROM ${table}_migrations ORDER BY version`,
		);
		expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
		expect(result.pgvectorVersion).toBe(pgvectorVersion);
		expect(result.warnings).toEqual(
			iterativeScan ? [] : [expect.stringContaining("Upgrade to 0.8.0")],
		);
	});

	it("should be a no-op when run again", async () => {
		const table = uniqueTable();
		await migrate(pool, { table });
		await pool.query(
			`INSERT INTO ${table} (namespace, model, key_version, params_hash, prompt_hash, prompt_text, embedding, response)
			 VALUES ('n', 'm', 1, 'p', 'h', 't', $1, '{}')`,
			[`[${new Array(1536).fill(0.1).join(",")}]`],
		);

		await migrate(pool, { table });

		const { rows } = await pool.query(
			`SELECT count(*)::int AS n FROM ${table}`,
		);
		expect(rows[0].n).toBe(1);
	});

	it("should succeed when several processes migrate at the same time", async () => {
		const table = uniqueTable();
		const runs = Array.from({ length: 5 }, () => migrate(pool, { table }));
		await expect(Promise.all(runs)).resolves.toHaveLength(5);
	});

	it("should succeed when different tables are migrated at once on a database without pgvector", async () => {
		const database = uniqueTable();
		await pool.query(`CREATE DATABASE ${database}`);
		const url = new URL(pool.options.connectionString ?? "");
		url.pathname = `/${database}`;
		const fresh = new pg.Pool({ connectionString: url.toString(), max: 5 });
		onTestFinished(() => fresh.end());

		const runs = Array.from({ length: 5 }, () =>
			migrate(fresh, { table: uniqueTable() }),
		);

		await expect(Promise.all(runs)).resolves.toHaveLength(5);
	});

	it("should upgrade a v1 table in place, keeping its rows", async () => {
		const table = uniqueTable();
		await migrate(pool, { table, dimensions: 3 });
		// Back to the v1 shape: embedding required, only version 1 recorded.
		await pool.query(
			`ALTER TABLE ${table} ALTER COLUMN embedding SET NOT NULL`,
		);
		await pool.query(`DELETE FROM ${table}_migrations WHERE version = 2`);
		await pool.query(
			`INSERT INTO ${table} (namespace, model, key_version, params_hash, prompt_hash, prompt_text, embedding, response)
			 VALUES ('n', 'm', 1, 'p', 'h', 't', '[1,0,0]', '{}')`,
		);

		await migrate(pool, { table, dimensions: 3 });

		const nullable = await pool.query(
			"SELECT NOT attnotnull AS nullable FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'embedding'",
			[table],
		);
		expect(nullable.rows[0].nullable).toBe(true);
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(1);
		const versions = await pool.query(
			`SELECT version FROM ${table}_migrations ORDER BY version`,
		);
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }]);
	});

	it("should not block readers when the table is already up to date", async () => {
		const table = uniqueTable();
		await migrate(pool, { table, dimensions: 3 });
		const reader = await pool.connect();
		onTestFinished(async () => {
			await reader.query("ROLLBACK").catch(() => {});
			reader.release();
		});
		// An open read holds AccessShareLock; an ALTER TABLE would wait behind it.
		await reader.query("BEGIN");
		await reader.query(`SELECT count(*) FROM ${table}`);

		const done = migrate(pool, { table, dimensions: 3 }).then(() => "migrated");
		const waited = new Promise((r) => setTimeout(() => r("blocked"), 2000));

		expect(await Promise.race([done, waited])).toBe("migrated");
	});

	it("should fail when the table already exists with a different vector size", async () => {
		const table = uniqueTable();
		await migrate(pool, { table, dimensions: 3 });
		await expect(migrate(pool, { table, dimensions: 4 })).rejects.toThrow(
			/3 dimensions.*4/,
		);
	});
});
