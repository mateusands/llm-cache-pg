/*
 * Contract: withClient never hands a client that failed or overran its deadline back to the pool,
 * and gives up on a server that accepts connections but never answers.
 */
import { createServer, type Socket } from "node:net";
import pg from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { TimeoutError, withClient } from "../../src/pg.ts";
import { testPool } from "./db.ts";

const pool = testPool();

describe("withClient", () => {
	it("should return the client to the pool when the work succeeds", async () => {
		const local = new pg.Pool({
			connectionString: pool.options.connectionString,
			max: 1,
		});
		onTestFinished(() => local.end());

		await withClient(local, (c) => c.query("SELECT 1"));

		expect(local.totalCount).toBe(1);
		expect(local.idleCount).toBe(1);
	});

	it("should destroy the client when the work fails", async () => {
		const local = new pg.Pool({
			connectionString: pool.options.connectionString,
			max: 1,
		});
		onTestFinished(() => local.end());

		await expect(
			withClient(local, (c) => c.query("SELECT nope")),
		).rejects.toThrow();

		expect(local.totalCount).toBe(0);
	});

	it("should destroy the client when the work overruns the deadline", async () => {
		const local = new pg.Pool({
			connectionString: pool.options.connectionString,
			max: 1,
		});
		onTestFinished(() => local.end());

		await expect(
			withClient(local, (c) => c.query("SELECT pg_sleep(2)"), 100),
		).rejects.toBeInstanceOf(TimeoutError);

		expect(local.totalCount).toBe(0);
		// The pool is usable right away, with a fresh connection.
		await expect(
			withClient(local, (c) => c.query("SELECT 1"), 1000),
		).resolves.toBeDefined();
	});

	it("should give up within the deadline when the server accepts but never answers", async () => {
		const sockets: Socket[] = [];
		const server = createServer((s) => sockets.push(s));
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const hung = new pg.Pool({
			host: "127.0.0.1",
			port: address.port,
			user: "x",
			database: "x",
		});
		onTestFinished(async () => {
			for (const s of sockets) s.destroy();
			server.close();
			await hung.end().catch(() => {});
		});

		const started = performance.now();
		await expect(
			withClient(hung, (c) => c.query("SELECT 1"), 150),
		).rejects.toBeInstanceOf(TimeoutError);

		expect(performance.now() - started).toBeLessThan(400);
	});
});
