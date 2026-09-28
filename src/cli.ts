import { parseArgs } from "node:util";
import { createCache } from "./cache.ts";
import { inspectTable, migrate, resolveMigrationOptions } from "./migrate.ts";
import type { Pool } from "./pg.ts";
import { countMatching } from "./store.ts";

const USAGE = `Usage: llm-cache-pg <command> [options]

Commands:
  migrate      Create or upgrade the cache table
  stats        Show entries, hits and size
  prune        Delete expired entries
  invalidate   Delete entries by --namespace and/or --model (a dry run without --yes)

Options:
  --url <url>          Postgres connection string (default: DATABASE_URL)
  --table <name>       Cache table (default: llm_cache_entries)
  --dimensions <n>     Embedding size, for migrate (default: 1536)
  --batch-size <n>     Rows per delete, for prune (default: 1000)
  --namespace <name>   Filter, for invalidate
  --model <name>       Filter, for invalidate
  --yes                Delete for real, for invalidate
  --json               Machine-readable output, for stats
  -h, --help           Show this help
`;

const COMMANDS = new Set(["migrate", "stats", "prune", "invalidate"]);

export interface CliIo {
	env?: Record<string, string | undefined>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

class UsageError extends Error {}

type ClosablePool = Pool & { end(): Promise<void> };

/**
 * Runs the CLI with `argv` (without the node and script paths) and returns the exit code:
 * 0 on success, 1 on a runtime failure, 2 on bad usage. Never prints the connection URL.
 */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
	const out = io.stdout ?? ((text: string) => process.stdout.write(text));
	const err = io.stderr ?? ((text: string) => process.stderr.write(text));
	const env = io.env ?? process.env;
	let url: string | undefined;

	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				url: { type: "string" },
				table: { type: "string" },
				dimensions: { type: "string" },
				"batch-size": { type: "string" },
				namespace: { type: "string" },
				model: { type: "string" },
				yes: { type: "boolean" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help) {
			out(USAGE);
			return 0;
		}
		const [command, ...extra] = positionals;
		if (!command) throw new UsageError("No command given.");
		if (!COMMANDS.has(command))
			throw new UsageError(`Unknown command "${command}".`);
		if (extra.length > 0)
			throw new UsageError(`Unexpected argument "${extra[0]}".`);

		let table: string;
		try {
			table = resolveMigrationOptions(
				values.table === undefined ? {} : { table: values.table },
			).table;
		} catch (error) {
			throw new UsageError((error as Error).message);
		}
		const dimensions = positive("--dimensions", values.dimensions, 1536);
		const batchSize = positive("--batch-size", values["batch-size"], 1000);
		if (
			command === "invalidate" &&
			values.namespace === undefined &&
			values.model === undefined
		) {
			throw new UsageError("invalidate needs --namespace or --model.");
		}
		url = values.url ?? env.DATABASE_URL;
		if (!url) throw new UsageError("Set DATABASE_URL or pass --url.");

		const pool = await openPool(url);
		try {
			if (command === "migrate") {
				const result = await migrate(pool, { table, dimensions });
				out(`Table ${table} is ready (pgvector ${result.pgvectorVersion}).\n`);
				for (const warning of result.warnings) out(`warning: ${warning}\n`);
				return 0;
			}

			// Admin calls never embed; the cache only needs an embedder to exist.
			const cache = createCache({
				pool,
				table,
				embed: async () => {
					throw new Error("not used by the CLI");
				},
			});

			if (command === "stats") {
				const stats = await cache.stats();
				if (values.json) {
					out(`${JSON.stringify(stats, null, 2)}\n`);
				} else {
					const list = (items: { name: string; entries: number }[]) =>
						items.map((i) => `${i.name} ${i.entries}`).join(", ") || "none";
					out(
						[
							`table        ${table} (schema v${stats.schemaVersion}, pgvector ${stats.pgvectorVersion})`,
							`entries      ${stats.entries} (${stats.expired} expired, ${stats.withoutEmbedding} without embedding)`,
							`hits         ${stats.hits}`,
							`size         ${bytes(stats.totalBytes)} (${bytes(stats.indexBytes)} in indexes)`,
							`namespaces   ${list(stats.namespaces)}`,
							`models       ${list(stats.models)}`,
							"",
						].join("\n"),
					);
				}
			} else if (command === "prune") {
				// Checked first so a missing table says to migrate instead of failing on SQL.
				await inspectTable(pool, table);
				out(`Deleted ${await cache.prune({ batchSize })} expired entries.\n`);
			} else {
				await inspectTable(pool, table);
				const filter = {
					...(values.namespace === undefined
						? {}
						: { namespace: values.namespace }),
					...(values.model === undefined ? {} : { model: values.model }),
				};
				if (values.yes) {
					out(`Deleted ${await cache.invalidate(filter)} entries.\n`);
				} else {
					const n = await countMatching(pool, table, filter);
					out(
						`Would delete ${n} entries. Run again with --yes to delete them.\n`,
					);
				}
			}
			return 0;
		} finally {
			await pool.end().catch(() => {});
		}
	} catch (error) {
		if (
			error instanceof UsageError ||
			(error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
		) {
			err(`${(error as Error).message}\n\n${USAGE}`);
			return 2;
		}
		err(`llm-cache-pg: ${describe(error, url)}\n`);
		return 1;
	}
}

function positive(
	flag: string,
	value: string | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0)
		throw new UsageError(`${flag} must be a positive integer.`);
	return n;
}

async function openPool(url: string): Promise<ClosablePool> {
	let pg: { Pool: new (config: object) => ClosablePool };
	try {
		const mod = (await import("pg")) as { default?: typeof pg } & typeof pg;
		pg = mod.default ?? mod;
	} catch {
		throw new Error("The CLI needs the pg package: npm install pg");
	}
	return new pg.Pool({
		connectionString: url,
		connectionTimeoutMillis: 10_000,
		max: 2,
	});
}

/** One line per underlying error. Connection failures are AggregateErrors with an empty message. */
function describe(error: unknown, url: string | undefined): string {
	const parts =
		error instanceof AggregateError && error.errors.length > 0
			? error.errors
			: [error];
	const text = parts
		.map((e) => {
			const code = (e as { code?: unknown }).code;
			const message = e instanceof Error ? e.message : String(e);
			return [typeof code === "string" ? code : "", message]
				.filter(Boolean)
				.join(": ");
		})
		.filter(Boolean)
		.join("; ");
	return redact(text || "unknown error", url);
}

/** Removes the URL and its password from `text`, in case an error message quotes them. */
export function redact(text: string, url: string | undefined): string {
	if (!url) return text;
	let clean = text.split(url).join("<url>");
	try {
		const password = decodeURIComponent(new URL(url).password);
		if (password) clean = clean.split(password).join("***");
	} catch {
		// Not a parseable URL: nothing more to find in it.
	}
	return clean;
}

function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
	return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
