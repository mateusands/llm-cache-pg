import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, inject } from "vitest";
import { supportsIterativeScan } from "../../src/migrate.ts";

export const pgvectorVersion: string = inject("pgvectorVersion");
export const iterativeScan: boolean = supportsIterativeScan(pgvectorVersion);

/** A pool for the shared container, closed after the calling test file. */
export function testPool(): pg.Pool {
	const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 5 });
	afterAll(() => pool.end());
	return pool;
}

/** A table name no other test uses, so files can run in parallel against one database. */
export function uniqueTable(): string {
	return `t_${randomBytes(6).toString("hex")}`;
}
