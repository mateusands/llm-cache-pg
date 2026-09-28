/*
 * Contract: the CLI runs the admin operations against a real database, deletes nothing without
 * --yes, exits 0 on success, 1 on a runtime failure and 2 on bad usage, and never prints the
 * connection URL, which can hold a password.
 */
import { describe, expect, inject, it } from "vitest";
import { createCache } from "../../src/cache.ts";
import { runCli } from "../../src/cli.ts";
import { migrate } from "../../src/migrate.ts";
import { testPool, uniqueTable } from "./db.ts";

const pool = testPool();
const url = inject("databaseUrl");

async function cli(...argv: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await runCli(argv, {
		env: { DATABASE_URL: url },
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stdout, stderr };
}

/** A table with 4 entries: 2 in tenant-a, 1 expired, 1 stored without an embedding, 1 hit. */
async function seeded() {
	const table = uniqueTable();
	await migrate(pool, { table, dimensions: 3 });
	const cache = createCache({ pool, table, embed: async () => [1, 0, 0] });
	const key = (text: string, model = "m1") => ({
		model,
		messages: [{ role: "user", content: text }],
	});
	await cache.set(key("a"), 1, { namespace: "tenant-a" });
	await cache.set(key("b"), 2, { namespace: "tenant-a", ttl: 1 });
	await cache.set(key("c"), 3, { namespace: "tenant-b", semantic: false });
	await cache.set(key("d", "m2"), 4, { namespace: "tenant-b" });
	await cache.get(key("a"), { namespace: "tenant-a" });
	await cache.flush();
	await new Promise((r) => setTimeout(r, 20));
	return table;
}

describe("llm-cache-pg CLI", () => {
	it("should create the table with migrate", async () => {
		const table = uniqueTable();

		const { code, stdout } = await cli(
			"migrate",
			"--table",
			table,
			"--dimensions",
			"3",
		);

		expect(code).toBe(0);
		expect(stdout).toContain(table);
		expect(
			(await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [table]))
				.rows[0].ok,
		).toBe(true);
	});

	it("should report exact numbers with stats --json", async () => {
		const table = await seeded();

		const { code, stdout } = await cli("stats", "--table", table, "--json");

		expect(code).toBe(0);
		const stats = JSON.parse(stdout);
		expect(stats).toMatchObject({
			entries: 4,
			expired: 1,
			withoutEmbedding: 1,
			hits: 1,
			schemaVersion: 2,
		});
		expect(stats.namespaces).toEqual([
			{ name: "tenant-a", entries: 2 },
			{ name: "tenant-b", entries: 2 },
		]);
		expect(stats.models).toEqual([
			{ name: "m1", entries: 3 },
			{ name: "m2", entries: 1 },
		]);
	});

	it("should print readable stats by default", async () => {
		const table = await seeded();

		const { code, stdout } = await cli("stats", "--table", table);

		expect(code).toBe(0);
		expect(stdout).toMatch(/entries\s+4 \(1 expired, 1 without embedding\)/);
		expect(stdout).toContain("tenant-a 2");
	});

	it("should delete only expired entries with prune", async () => {
		const table = await seeded();

		const { code, stdout } = await cli("prune", "--table", table);

		expect(code).toBe(0);
		expect(stdout).toContain("1");
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(3);
	});

	it("should only count what invalidate would delete, until --yes", async () => {
		const table = await seeded();

		const dry = await cli(
			"invalidate",
			"--table",
			table,
			"--namespace",
			"tenant-a",
		);
		expect(dry.code).toBe(0);
		expect(dry.stdout).toMatch(/would delete 2/i);
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(4);

		const real = await cli(
			"invalidate",
			"--table",
			table,
			"--namespace",
			"tenant-a",
			"--yes",
		);
		expect(real.code).toBe(0);
		expect(real.stdout).toMatch(/deleted 2/i);
		expect(
			(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
		).toBe(2);
	});

	it.each([
		["no command", []],
		["an unknown command", ["frobnicate"]],
		["an unknown flag", ["stats", "--verbose"]],
		["invalidate without a filter", ["invalidate", "--yes"]],
		["an invalid table name", ["stats", "--table", "Bad Name"]],
		["bad dimensions", ["migrate", "--dimensions", "lots"]],
	])("should exit 2 with usage help for %s", async (_, argv) => {
		const { code, stderr } = await cli(...argv);

		expect(code).toBe(2);
		expect(stderr).toMatch(/usage/i);
	});

	it("should exit 0 and print help with --help", async () => {
		const { code, stdout } = await cli("--help");

		expect(code).toBe(0);
		expect(stdout).toMatch(/usage/i);
	});

	it("should exit 2 when no connection URL is given", async () => {
		let stderr = "";
		const code = await runCli(["stats"], {
			env: {},
			stdout: () => {},
			stderr: (t) => {
				stderr += t;
			},
		});

		expect(code).toBe(2);
		expect(stderr).toMatch(/DATABASE_URL/);
	});

	it("should exit 1 with a readable error that never shows the URL when the database is down", async () => {
		// localhost resolves to IPv4 and IPv6, so the failure is an AggregateError with an empty message.
		const secretUrl = "postgres://admin:hunter2@localhost:1/cache";

		const { code, stderr } = await cli("stats", "--url", secretUrl);

		expect(code).toBe(1);
		expect(stderr).toContain("ECONNREFUSED");
		expect(stderr).not.toContain("hunter2");
		expect(stderr).not.toContain(secretUrl);
	});

	it("should exit 1 and say to migrate when the table does not exist", async () => {
		const { code, stderr } = await cli("stats", "--table", uniqueTable());

		expect(code).toBe(1);
		expect(stderr).toMatch(/migrate/);
	});
});
