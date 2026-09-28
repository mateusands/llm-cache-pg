// Installs the packed tarball into a fresh project and checks it the way a user would consume it:
// ESM import, CJS require, and strict type checking with and without the optional openai peer.
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "llm-cache-pg-consumer-"));
const run = (cmd, args, cwd = dir) =>
	execFileSync(cmd, args, { cwd, stdio: "inherit" });

try {
	// SMOKE_FROM_REGISTRY=0.3.0 checks a published version instead of the local build.
	const published = process.env.SMOKE_FROM_REGISTRY;
	let spec = `llm-cache-pg@${published}`;
	if (!published) {
		run("pnpm", ["pack", "--pack-destination", dir], root);
		const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));

		// Everything outside dist/ is listed on purpose: a new file in the package should be a decision.
		const files = execFileSync("tar", ["-tzf", join(dir, tarball)], {
			encoding: "utf8",
		})
			.trim()
			.split("\n");
		const extra = files.filter((f) => !f.startsWith("package/dist/")).sort();
		const expected = [
			"package/CHANGELOG.md",
			"package/LICENSE",
			"package/README.md",
			"package/README.pt-BR.md",
			"package/package.json",
		];
		if (JSON.stringify(extra) !== JSON.stringify(expected)) {
			throw new Error(`unexpected package files: ${extra.join(", ")}`);
		}
		console.log("package files ok");
		spec = `./${tarball}`;
	}

	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "consumer", private: true, type: "module" }),
	);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				types: [],
			},
		}),
	);
	run("npm", [
		"install",
		"--no-audit",
		"--no-fund",
		spec,
		"typescript@7",
		"@types/node@22",
	]);

	// Before any SDK is installed: the core and the metrics entry must load on their own.
	writeFileSync(
		join(dir, "core.mjs"),
		`import { createCache, migrate, renderMigrationSql } from "llm-cache-pg";
import { prometheusHooks } from "llm-cache-pg/prometheus";
for (const f of [createCache, migrate, renderMigrationSql, prometheusHooks]) {
  if (typeof f !== "function") throw new Error("missing export");
}
if (!renderMigrationSql().includes("CREATE TABLE")) throw new Error("bad SQL");
console.log("esm core ok without SDKs");`,
	);
	writeFileSync(
		join(dir, "core.cjs"),
		`const { createCache } = require("llm-cache-pg");
const { prometheusHooks } = require("llm-cache-pg/prometheus");
if (typeof createCache !== "function" || typeof prometheusHooks !== "function") throw new Error("missing export");
console.log("cjs core ok without SDKs");`,
	);
	run("node", ["core.mjs"]);
	run("node", ["core.cjs"]);

	// Each provider entry may import its own SDK (to replay streams); nothing else imports any.
	const dist = join(dir, "node_modules", "llm-cache-pg", "dist");
	const sdks = [
		"openai",
		"@anthropic-ai/sdk",
		"prom-client",
		"@prometheus-io/client",
		"pg",
	];
	for (const file of readdirSync(dist).filter((f) => /\.(mjs|cjs)$/.test(f))) {
		const code = readFileSync(join(dist, file), "utf8");
		const used = sdks.filter((sdk) =>
			new RegExp(`(from|require\\()\\s*["']${sdk}(/[^"']*)?["']`).test(code),
		);
		const allowed = file.startsWith("openai.")
			? ["openai"]
			: file.startsWith("anthropic.")
				? ["@anthropic-ai/sdk"]
				: [];
		if (used.some((sdk) => !allowed.includes(sdk)))
			throw new Error(`${file} imports ${used.join(", ")}`);
	}
	console.log("runtime imports ok");

	// The core types must not need openai (or pg) installed.
	writeFileSync(
		join(dir, "core.ts"),
		`import { createCache, type Pool } from "llm-cache-pg";
declare const pool: Pool;
createCache({ pool, embed: async () => [0], threshold: 0.9, ttl: "7d" });`,
	);
	run("npx", ["tsc", "-p", "."]);
	console.log("core types ok without openai");

	run("npm", [
		"install",
		"--no-audit",
		"--no-fund",
		"openai@7",
		"@prometheus-io/client@0.16",
		"prom-client@15",
		"@anthropic-ai/sdk@0.128",
	]);
	writeFileSync(
		join(dir, "providers.mjs"),
		`import { withCache, openaiEmbedder } from "llm-cache-pg/openai";
import { withCache as withAnthropicCache } from "llm-cache-pg/anthropic";
for (const f of [withCache, openaiEmbedder, withAnthropicCache]) if (typeof f !== "function") throw new Error("missing export");
console.log("esm providers ok");`,
	);
	writeFileSync(
		join(dir, "providers.cjs"),
		`const { withCache } = require("llm-cache-pg/openai");
const { withCache: withAnthropicCache } = require("llm-cache-pg/anthropic");
if (typeof withCache !== "function" || typeof withAnthropicCache !== "function") throw new Error("missing export");
console.log("cjs providers ok");`,
	);
	run("node", ["providers.mjs"]);
	run("node", ["providers.cjs"]);
	writeFileSync(
		join(dir, "openai.ts"),
		`import OpenAI from "openai";
import { createCache, type Pool } from "llm-cache-pg";
import { openaiEmbedder, withCache } from "llm-cache-pg/openai";
declare const pool: Pool;
const client = new OpenAI({ apiKey: "x" });
const cache = createCache({ pool, embed: openaiEmbedder({ client, model: "text-embedding-3-small" }) });
const ai = withCache(client, cache, { namespace: "t" });
const res = ai.chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] });
res.then((r) => r.choices[0]?.message.content);
const streamed = ai.chat.completions.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
streamed.then(async (s) => { for await (const chunk of s) chunk.choices[0]?.delta.content; });`,
	);
	writeFileSync(
		join(dir, "anthropic.ts"),
		`import Anthropic from "@anthropic-ai/sdk";
import { createCache, type Pool } from "llm-cache-pg";
import { withCache } from "llm-cache-pg/anthropic";
declare const pool: Pool;
const cache = createCache({ pool, embed: async () => [0] });
const ai = withCache(new Anthropic({ apiKey: "x" }), cache, { namespace: "t" });
ai.messages.create({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).then((r) => r.content);
ai.messages.create({ model: "m", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }).then(async (s) => { for await (const e of s) e.type; });`,
	);
	writeFileSync(
		join(dir, "prometheus.ts"),
		`import * as client from "@prometheus-io/client";
import * as legacy from "prom-client";
import { createCache, type Pool } from "llm-cache-pg";
import { prometheusHooks } from "llm-cache-pg/prometheus";
declare const pool: Pool;
createCache({ pool, embed: async () => [0], ...prometheusHooks({ client, pool }) });
createCache({ pool, embed: async () => [0], ...prometheusHooks({ client: legacy, registry: new legacy.Registry() }) });`,
	);
	run("npx", ["tsc", "-p", "."]);
	console.log("openai, anthropic and prometheus types ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
