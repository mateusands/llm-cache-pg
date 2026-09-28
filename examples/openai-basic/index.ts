// Asks a few variations of one question and prints how each was answered.
// Run from the repo root with OPENAI_API_KEY set in .env (see .env.example):
// docker compose -f examples/docker-compose.yml up -d && pnpm example

import { createCache, type LookupEvent, migrate } from "llm-cache-pg";
import { openaiEmbedder, withCache } from "llm-cache-pg/openai";
import OpenAI from "openai";
import pg from "pg";

const pool = new pg.Pool({
	connectionString:
		process.env.DATABASE_URL ??
		"postgres://postgres:postgres@localhost:5432/postgres",
});
const openai = new OpenAI();

const table = "llm_cache_example";
const { warnings } = await migrate(pool, { table, dimensions: 1536 });
for (const w of warnings) console.warn(w);
await pool.query(`TRUNCATE ${table}`);

let last: LookupEvent | undefined;
const cache = createCache({
	pool,
	table,
	embed: openaiEmbedder({ client: openai, model: "text-embedding-3-small" }),
	awaitStore: true,
	onLookup: (event) => {
		last = event;
	},
});
const ai = withCache(openai, cache, { namespace: "example" });

const questions = [
	"How do I reset my password?",
	// Close rewording: a semantic hit.
	"How can I reset my password?",
	// Same intent, looser wording: under the default threshold with text-embedding-3-small.
	"I forgot my password, what should I do?",
	"How do I cancel my subscription?",
	// Verbatim repeat: an exact hit, no embedding call.
	"How do I reset my password?",
];

for (const question of questions) {
	const started = performance.now();
	const res = await ai.chat.completions.create({
		model: "gpt-4.1-mini",
		temperature: 0,
		messages: [
			{
				role: "system",
				content: "You are a support bot for a web app. Answer in one sentence.",
			},
			{ role: "user", content: question },
		],
	});
	const ms = Math.round(performance.now() - started);
	const similarity =
		last?.similarity === undefined
			? ""
			: ` similarity=${last.similarity.toFixed(3)}`;
	console.log(
		`${last?.result}${similarity} ${ms}ms  ${question}\n  -> ${res.choices[0]?.message.content}\n`,
	);
}

await cache.flush();
await pool.end();
