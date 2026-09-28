/*
 * Structural types for the subset of node-postgres the library calls, so a `pg.Pool` fits without
 * the package (or @types/pg) becoming a dependency of the published types.
 */

export interface QueryResult<Row> {
	rows: Row[];
	rowCount: number | null;
}

export interface PoolClient {
	query<Row = Record<string, unknown>>(
		text: string,
		values?: unknown[],
	): Promise<QueryResult<Row>>;
	/** `true` destroys the connection instead of returning it to the pool. */
	release(destroy?: boolean | Error): void;
}

export interface Pool {
	query<Row = Record<string, unknown>>(
		text: string,
		values?: unknown[],
	): Promise<QueryResult<Row>>;
	connect(): Promise<PoolClient>;
}

export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Timed out after ${ms} ms`);
		this.name = "TimeoutError";
	}
}

/**
 * Runs `fn` on one pooled client. The client goes back to the pool only after `fn` succeeds; on an
 * error or when `timeoutMs` passes (connect included) it is destroyed, so an open transaction or a
 * query still running is never handed to the next caller.
 */
export async function withClient<T>(
	pool: Pool,
	fn: (client: PoolClient) => Promise<T>,
	timeoutMs?: number,
): Promise<T> {
	let expired = false;
	let active: PoolClient | undefined;
	let timer: NodeJS.Timeout | undefined;

	const work = (async () => {
		const client = await pool.connect();
		if (expired) {
			// Arrived after the deadline and was never used, so it is safe to reuse.
			client.release();
			throw new TimeoutError(timeoutMs ?? 0);
		}
		active = client;
		try {
			const result = await fn(client);
			if (active) client.release();
			return result;
		} catch (err) {
			if (active) client.release(true);
			throw err;
		} finally {
			active = undefined;
		}
	})();

	if (timeoutMs === undefined) return work;

	// The deadline may win the race; the loser's rejection must not surface as unhandled.
	work.catch(() => {});
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			expired = true;
			active?.release(true);
			active = undefined;
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
