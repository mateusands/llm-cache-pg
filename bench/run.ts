// Measures hit rate and false-hit rate per threshold on labelled question pairs, through the
// library itself against a real Postgres. Needs Docker and OPENAI_API_KEY; run with `pnpm bench`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import OpenAI from "openai";
import pg from "pg";
import { createCache, type Durations, type LookupEvent } from "../src/cache.ts";
import type { KeyInput } from "../src/key.ts";
import { migrate } from "../src/migrate.ts";
import { type BenchRecord, dedupePairs, type Pair, score } from "./score.ts";

const HERE = new URL(".", import.meta.url).pathname;
const CACHE_DIR = `${HERE}.cache`;
const RESULTS_DIR = `${HERE}results`;
const QQP_PAIRS = 1000;
const QQP_ROWS_TO_SCAN = 3000;
const THRESHOLDS = Array.from({ length: 20 }, (_, i) =>
	Number((0.8 + i * 0.01).toFixed(2)),
);
const EMBEDDERS = [
	{
		name: "text-embedding-3-small",
		model: "text-embedding-3-small",
		dimensions: 1536,
	},
	// 2000 is the most HNSW indexes on `vector` accept.
	{
		name: "text-embedding-3-large@2000",
		model: "text-embedding-3-large",
		dimensions: 2000,
	},
];

interface Dataset {
	name: string;
	namespace: string;
	pairs: Pair[];
}

async function loadQqp(): Promise<Pair[]> {
	// Quora's terms allow non-commercial use but not redistribution, so the rows are fetched, not committed.
	const file = `${CACHE_DIR}/qqp-validation-${QQP_ROWS_TO_SCAN}.json`;
	if (!existsSync(file)) {
		const rows: Pair[] = [];
		for (let offset = 0; offset < QQP_ROWS_TO_SCAN; offset += 100) {
			const url = `https://datasets-server.huggingface.co/rows?dataset=nyu-mll%2Fglue&config=qqp&split=validation&offset=${offset}&length=100`;
			const res = await fetch(url);
			if (!res.ok)
				throw new Error(
					`QQP download failed: ${res.status} at offset ${offset}`,
				);
			const body = (await res.json()) as {
				rows: {
					row: { question1: string; question2: string; label: number };
				}[];
			};
			for (const { row } of body.rows) {
				rows.push({
					q1: row.question1,
					q2: row.question2,
					duplicate: row.label === 1,
				});
			}
		}
		writeFileSync(file, JSON.stringify(rows));
	}
	return dedupePairs(
		JSON.parse(readFileSync(file, "utf8")) as Pair[],
		QQP_PAIRS,
	);
}

function loadFaq(): Dataset[] {
	const faq = JSON.parse(
		readFileSync(`${HERE}data/faq.json`, "utf8"),
	) as Record<string, Pair[]>;
	return ["en", "pt"].map((lang) => ({
		name: `faq-${lang}`,
		namespace: `faq-${lang}`,
		pairs: faq[lang] ?? [],
	}));
}

/** Embeds every text once per model, in batches, and keeps the vectors on disk for later runs. */
async function embeddingsFor(
	openai: OpenAI,
	embedder: (typeof EMBEDDERS)[number],
	texts: string[],
): Promise<Map<string, number[]>> {
	const file = `${CACHE_DIR}/embeddings-${embedder.name}.json`;
	const stored: Record<string, string> = existsSync(file)
		? JSON.parse(readFileSync(file, "utf8"))
		: {};
	const hash = (t: string) => createHash("sha256").update(t).digest("hex");
	const missing = [...new Set(texts)].filter((t) => !stored[hash(t)]);
	for (let i = 0; i < missing.length; i += 256) {
		const batch = missing.slice(i, i + 256);
		const res = await openai.embeddings.create({
			model: embedder.model,
			input: batch,
			dimensions: embedder.dimensions,
			encoding_format: "float",
		});
		for (const item of res.data) {
			const text = batch[item.index];
			if (text !== undefined) {
				stored[hash(text)] = Buffer.from(
					new Float32Array(item.embedding).buffer,
				).toString("base64");
			}
		}
	}
	if (missing.length) writeFileSync(file, JSON.stringify(stored));
	console.error(
		`${embedder.name}: ${missing.length} new embeddings, ${texts.length - missing.length} cached`,
	);
	const vectors = new Map<string, number[]>();
	for (const t of texts) {
		const bytes = Buffer.from(stored[hash(t)] ?? "", "base64");
		vectors.set(
			t,
			Array.from(
				new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
			),
		);
	}
	return vectors;
}

const keyFor = (text: string): KeyInput => ({
	model: "bench",
	messages: [{ role: "user", content: text }],
});

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[
			Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
		] ?? 0
	);
}

async function runDataset(
	pool: pg.Pool,
	dataset: Dataset,
	embedder: (typeof EMBEDDERS)[number],
	vectors: Map<string, number[]>,
): Promise<{ records: BenchRecord[]; durations: Durations[] }> {
	const table = `bench_${createHash("sha256")
		.update(dataset.name + embedder.name)
		.digest("hex")
		.slice(0, 8)}`;
	await migrate(pool, { table, dimensions: embedder.dimensions });
	await pool.query(`TRUNCATE ${table}`);
	let pending: LookupEvent | undefined;
	// Returns the event of the lookup that just ran, and clears it for the next one.
	const takeEvent = (): LookupEvent | undefined => {
		const event = pending;
		pending = undefined;
		return event;
	};
	const errors: string[] = [];
	const cache = createCache({
		pool,
		table,
		// Low on purpose: the threshold sweep happens afterwards, on the recorded similarities.
		threshold: 0.5,
		lookupTimeoutMs: 5000,
		embed: async (text) => {
			const v = vectors.get(text);
			if (!v) throw new Error("missing embedding");
			return v;
		},
		onLookup: (event) => {
			pending = event;
		},
		// Thrown errors are swallowed by design; collect them and fail the run instead.
		onError: (error, stage) => errors.push(`${stage}: ${error}`),
	});

	for (const [i, pair] of dataset.pairs.entries()) {
		await cache.set(
			keyFor(pair.q1),
			{ pair: i },
			{ namespace: dataset.namespace },
		);
	}
	const records: BenchRecord[] = [];
	const durations: Durations[] = [];
	for (const [i, pair] of dataset.pairs.entries()) {
		const found = await cache.get<{ pair: number }>(keyFor(pair.q2), {
			namespace: dataset.namespace,
		});
		const event = takeEvent();
		records.push({
			duplicate: pair.duplicate,
			similarity: event?.similarity ?? null,
			match: found ? (found.response.pair === i ? "own" : "other") : null,
		});
		if (event) durations.push(event.durations);
	}
	await cache.flush();
	if (errors.length)
		throw new Error(
			`${dataset.name}: ${errors.length} cache errors, first: ${errors[0]}`,
		);
	return { records, durations };
}

function toCsv(rows: Record<string, unknown>[]): string {
	const header = Object.keys(rows[0] ?? {});
	return [
		header.join(","),
		...rows.map((r) => header.map((h) => JSON.stringify(r[h] ?? "")).join(",")),
	].join("\n");
}

async function main(): Promise<void> {
	mkdirSync(CACHE_DIR, { recursive: true });
	mkdirSync(RESULTS_DIR, { recursive: true });
	const datasets: Dataset[] = [
		{ name: "qqp", namespace: "qqp", pairs: await loadQqp() },
		...loadFaq(),
	];
	const texts = datasets.flatMap((d) => d.pairs.flatMap((p) => [p.q1, p.q2]));
	const openai = new OpenAI();

	const container = await new PostgreSqlContainer(
		"pgvector/pgvector:0.8.6-pg18",
	).start();
	const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
	const summary: Record<string, unknown>[] = [];
	try {
		for (const embedder of EMBEDDERS) {
			const vectors = await embeddingsFor(openai, embedder, texts);
			for (const dataset of datasets) {
				const { records, durations } = await runDataset(
					pool,
					dataset,
					embedder,
					vectors,
				);
				writeFileSync(
					`${RESULTS_DIR}/${dataset.name}-${embedder.name}.csv`,
					toCsv(records.map((r, i) => ({ pair: i, ...r }))),
				);
				for (const row of score(records, THRESHOLDS)) {
					summary.push({
						dataset: dataset.name,
						embedder: embedder.name,
						...row,
					});
				}
				const exact = durations.map((d) => d.exact ?? 0);
				const semantic = durations.map((d) => d.semantic ?? 0);
				console.error(
					`${dataset.name} / ${embedder.name}: lookup p50/p95 exact ${percentile(exact, 50).toFixed(2)}/${percentile(exact, 95).toFixed(2)} ms, semantic ${percentile(semantic, 50).toFixed(2)}/${percentile(semantic, 95).toFixed(2)} ms`,
				);
			}
		}
	} finally {
		await pool.end();
		await container.stop();
	}
	writeFileSync(`${RESULTS_DIR}/summary.csv`, toCsv(summary));

	const shown = new Set([0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.96]);
	console.log(
		"| dataset | embedder | threshold | hit rate | false-hit rate | hits: correct / false / other pair |",
	);
	console.log("| --- | --- | --- | --- | --- | --- |");
	for (const r of summary) {
		if (!shown.has(r.threshold as number)) continue;
		const pct = (x: unknown) => `${((x as number) * 100).toFixed(1)}%`;
		console.log(
			`| ${r.dataset} (n=${r.pairs}) | ${r.embedder} | ${r.threshold} | ${pct(r.hitRate)} | ${pct(r.falseHitRate)} | ${r.correct} / ${r.falseHits} / ${r.otherPair} |`,
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
