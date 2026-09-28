// Sends a steady stream of support questions through the cache and serves Prometheus metrics on
// :9464/metrics. Runs inside examples/metrics/docker-compose.yml; see the comment there.
//
// Without OPENAI_API_KEY (or with DEMO_OFFLINE=1) both the model and the embedder are fakes. With the
// key, embeddings come from OpenAI; the model stays fake so hours of traffic cost nothing extra.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import * as client from "@prometheus-io/client";
import {
	createCache,
	type Embedder,
	type KeyInput,
	migrate,
} from "llm-cache-pg";
import { openaiEmbedder } from "llm-cache-pg/openai";
import { prometheusHooks } from "llm-cache-pg/prometheus";
import OpenAI from "openai";
import pg from "pg";

const PORT = 9464;
const INTERVAL_MS = 200;
// Every Nth fake embedding fails, so the errors panel has something to show.
const FAIL_EVERY = 40;
// Share of requests sent in shadow mode, so the shadow panels have data too.
const SHADOW_SHARE = 0.1;

const pool = new pg.Pool({
	connectionString:
		process.env.DEMO_DATABASE_URL ??
		"postgres://postgres:postgres@localhost:55432/postgres",
});

/** Bag of words hashed into 64 dimensions: crude, but gives similar texts similar vectors. */
function fakeEmbedder(): Embedder {
	let calls = 0;
	return async (text) => {
		calls++;
		if (calls % FAIL_EVERY === 0) throw new Error("simulated embedding outage");
		const v = new Array<number>(64).fill(0);
		for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
			const bucket = createHash("sha256").update(word).digest()[0] ?? 0;
			v[bucket % 64] = (v[bucket % 64] ?? 0) + 1;
		}
		return v;
	};
}

const useOpenAI =
	Boolean(process.env.OPENAI_API_KEY) && process.env.DEMO_OFFLINE !== "1";
const embed = useOpenAI
	? openaiEmbedder({ client: new OpenAI(), model: "text-embedding-3-small" })
	: fakeEmbedder();
const dimensions = useOpenAI ? 1536 : 64;
const table = useOpenAI ? "llm_cache_demo_openai" : "llm_cache_demo";

// On first start the Postgres image restarts once after initdb, so the first connections can drop.
for (let attempt = 1; ; attempt++) {
	try {
		await migrate(pool, { table, dimensions });
		break;
	} catch (error) {
		if (attempt === 30) throw error;
		await new Promise((r) => setTimeout(r, 1000));
	}
}
const registry = new client.Registry();
const cache = createCache({
	pool,
	table,
	embed,
	ttl: "10m",
	...prometheusHooks({ client, registry, pool, table }),
});

const SYSTEM = {
	role: "system",
	content: "You are a support bot. Answer in one sentence.",
};
const FAQ = [
	"How do I reset my password?",
	"How do I change my email address?",
	"Can I get a refund for my last payment?",
	"How do I cancel my subscription?",
	"Where can I download my invoices?",
];
const REWORDED = [
	"how do i reset my password please",
	"How can I change my email address?",
	"can i get a refund for my last payment",
	"How do I cancel my subscription today?",
	"where can i download invoices",
];

const THINGS = [
	"webhooks",
	"single sign-on",
	"audit logs",
	"API keys",
	"custom domains",
	"data exports",
	"team roles",
	"invoices in euros",
	"a sandbox",
	"IP allowlists",
];
const PLACES = [
	"a new workspace",
	"our mobile app",
	"the staging environment",
	"a partner account",
	"my accountant",
	"a second region",
	"our CI pipeline",
	"an offline store",
];

/** A mix of exact repeats, rewordings, new questions and one request the cache must bypass. */
function nextRequest(): KeyInput {
	const roll = Math.random();
	const pick = (list: string[]) =>
		list[Math.floor(Math.random() * list.length)] ?? "";
	let messages: KeyInput["messages"];
	if (roll < 0.05) {
		// Ends with an assistant message, so it is never cacheable.
		messages = [
			SYSTEM,
			{ role: "user", content: pick(FAQ) },
			{ role: "assistant", content: "Sure," },
		];
	} else if (roll < 0.55) {
		messages = [SYSTEM, { role: "user", content: pick(FAQ) }];
	} else if (roll < 0.8) {
		messages = [SYSTEM, { role: "user", content: pick(REWORDED) }];
	} else {
		// Numbers alone would not do: "Question 1" and "Question 2" embed as the same question.
		messages = [
			SYSTEM,
			{
				role: "user",
				content: `How do I set up ${pick(THINGS)} for ${pick(PLACES)}?`,
			},
		];
	}
	return { model: "demo-model", messages, params: { temperature: 0 } };
}

async function fakeModel(): Promise<{
	answer: string;
	usage: { input: number; output: number };
}> {
	await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
	return {
		answer: "Here is how to do that.",
		usage: { input: 40 + Math.floor(Math.random() * 40), output: 25 },
	};
}

setInterval(() => {
	cache
		.wrap(fakeModel, {
			key: nextRequest(),
			usage: (r) => r.usage,
			shadow: Math.random() < SHADOW_SHARE,
		})
		.catch((error) => console.error("request failed:", error));
}, INTERVAL_MS);

createServer(async (req, res) => {
	if (req.url !== "/metrics") {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "Content-Type": registry.contentType });
	res.end(await registry.metrics());
}).listen(PORT, () => {
	console.log(
		`metrics on http://localhost:${PORT}/metrics (${useOpenAI ? "OpenAI embeddings" : "offline fakes"})`,
	);
});
