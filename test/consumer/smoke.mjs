// Installs the packed tarball into a fresh project and checks it the way a user would consume it:
// ESM import, CJS require, and strict type checking with and without the optional openai peer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "llm-cache-pg-consumer-"));
const run = (cmd, args, cwd = dir) =>
	execFileSync(cmd, args, { cwd, stdio: "inherit" });

try {
	run("pnpm", ["pack", "--pack-destination", dir], root);
	const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));

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
		`./${tarball}`,
		"typescript@7",
		"@types/node@22",
	]);

	writeFileSync(
		join(dir, "esm.mjs"),
		`import { createCache, migrate, renderMigrationSql } from "llm-cache-pg";
import { withCache, openaiEmbedder } from "llm-cache-pg/openai";
for (const f of [createCache, migrate, renderMigrationSql, withCache, openaiEmbedder]) {
  if (typeof f !== "function") throw new Error("missing export");
}
if (!renderMigrationSql().includes("CREATE TABLE")) throw new Error("bad SQL");
console.log("esm ok");`,
	);
	writeFileSync(
		join(dir, "cjs.cjs"),
		`const { createCache } = require("llm-cache-pg");
const { withCache } = require("llm-cache-pg/openai");
if (typeof createCache !== "function" || typeof withCache !== "function") throw new Error("missing export");
console.log("cjs ok");`,
	);
	run("node", ["esm.mjs"]);
	run("node", ["cjs.cjs"]);

	// The core types must not need openai (or pg) installed.
	writeFileSync(
		join(dir, "core.ts"),
		`import { createCache, type Pool } from "llm-cache-pg";
declare const pool: Pool;
createCache({ pool, embed: async () => [0], threshold: 0.9, ttl: "7d" });`,
	);
	run("npx", ["tsc", "-p", "."]);
	console.log("core types ok without openai");

	run("npm", ["install", "--no-audit", "--no-fund", "openai@7"]);
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
res.then((r) => r.choices[0]?.message.content);`,
	);
	run("npx", ["tsc", "-p", "."]);
	console.log("openai types ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
