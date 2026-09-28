import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}

// Pinned so a new pgvector release can't change results between runs.
export const PGVECTOR_IMAGE = "pgvector/pgvector:0.8.6-pg18";

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
	container = await new PostgreSqlContainer(PGVECTOR_IMAGE).start();
	project.provide("databaseUrl", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
	await container?.stop();
}
