import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		databaseUrl: string;
		/** The pgvector version the extension installs, e.g. "0.8.6". */
		pgvectorVersion: string;
	}
}

// Pinned so a new pgvector release can't change results between runs; CI overrides it per job.
const PGVECTOR_IMAGE =
	process.env.PGVECTOR_IMAGE ?? "pgvector/pgvector:0.8.6-pg18";

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
	container = await new PostgreSqlContainer(PGVECTOR_IMAGE).start();
	const databaseUrl = container.getConnectionUri();
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	const { rows } = await client.query(
		"SELECT default_version FROM pg_available_extensions WHERE name = 'vector'",
	);
	await client.end();
	project.provide("databaseUrl", databaseUrl);
	project.provide("pgvectorVersion", rows[0].default_version);
}

export async function teardown(): Promise<void> {
	await container?.stop();
}
