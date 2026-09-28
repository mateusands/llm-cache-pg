# llm-cache-pg

[Português](README.pt-BR.md)

**Semantic cache for LLM calls in TypeScript, backed by plain PostgreSQL + pgvector.** Runs on any Postgres that has pgvector (RDS, Supabase, Neon, self-hosted) with no custom extension to install. Wraps your OpenAI or Anthropic call in one line, isolates data per tenant, and exports Prometheus metrics with a ready-made Grafana dashboard.

> **Status: v0.1, not yet on npm.** Core cache, OpenAI wrapper and migration are implemented and tested against real Postgres. Anthropic, metrics and the Grafana dashboard come next (see [Roadmap](#roadmap)). The API may still change before 1.0.

---

## Why

LLM apps ask the same question in different words all the time. "How do I reset my password?" and "How can I reset my password?" should not cost two model calls.

A semantic cache embeds the prompt, looks for a close enough match that was already answered, and returns the stored answer instead of calling the model.

Existing options don't fit a typical TypeScript + Postgres stack:

| Option | Why it doesn't fit |
| --- | --- |
| [pg_semantic_cache](https://github.com/pgedge/pg_semantic_cache) | Postgres C/PLpgSQL extension: needs `make install` and superuser, so it doesn't run on managed Postgres. No app-side integration. |
| [@upstash/semantic-cache](https://www.npmjs.com/package/@upstash/semantic-cache) | Locked to Upstash Vector; last release Nov 2024. |
| GPTCache, RedisVL | Python only. |

`llm-cache-pg` lives in your app, uses the Postgres you already run, and only needs the `vector` extension, which managed providers already allow.

**Requirements:** Node 22+, PostgreSQL with pgvector 0.8+ (older pgvector works, with weaker semantic lookups in busy namespaces). No runtime dependencies: you bring the `pg` pool and, optionally, the `openai` client.

## Features

- **Exact + semantic lookup:** hash match first (free), vector similarity second.
- **One-line wrapper** for the OpenAI SDK, plus a generic `cache.wrap(fn)`.
- **Safe cache keys:** the whole request is part of the key except the last user message, which is the only part compared by vector. Model, system prompt, earlier turns, temperature, tools and any field the SDK adds later all have to match exactly.
- **Fail-open:** if the database or the embedder is down or slow, your call goes straight to the model and the error goes to `onError`.
- **Multi-tenant** via `namespace`: no cross-tenant hits.
- **TTL** per cache or per call; an expired key is cached again on its next miss.
- **Bring your own embedder:** OpenAI embeddings built in, or any `(text, { signal }) => Promise<number[]>`.
- **Migration** as a function or as plain SQL for your own migration tool, with an HNSW index.

Planned: Anthropic wrapper, invalidation API, Prometheus metrics and a Grafana dashboard.

## Quick start

```ts
import pg from "pg";
import OpenAI from "openai";
import { createCache, migrate } from "llm-cache-pg";
import { openaiEmbedder, withCache } from "llm-cache-pg/openai";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI();

await migrate(pool, { dimensions: 1536 }); // idempotent, safe on every startup

const cache = createCache({
  pool,
  embed: openaiEmbedder({ client: openai, model: "text-embedding-3-small" }),
  threshold: 0.92, // cosine similarity needed for a semantic hit
  ttl: "7d",
});

// Option 1: wrap the client
const ai = withCache(openai, cache, { namespace: tenantId });
const res = await ai.chat.completions.create({ model: "gpt-4.1-mini", messages });

// Option 2: wrap any call whose result is JSON
const answer = await cache.wrap(() => callSomeModel(messages), {
  namespace: tenantId,
  key: { model: "some-model", messages, params: { temperature: 0 } },
});

// On shutdown: wait for background writes, then close the pool
await cache.flush();
await pool.end();
```

A runnable version is in [examples/openai-basic](examples/openai-basic/index.ts): copy `.env.example` to `.env`, add your OpenAI key, then `docker compose -f examples/docker-compose.yml up -d && pnpm example`.

## What is never cached

- Streaming, `n > 1` and audio requests: passed straight to the SDK.
- Requests whose last message isn't from the user, or has non-text parts such as images.
- Responses with tool calls or a `finish_reason` other than `stop`.

With the OpenAI wrapper, a cached answer comes back as a plain `Promise<ChatCompletion>`, so `.withResponse()` isn't available on non-streaming calls.

## Choosing a threshold

Measured with `text-embedding-3-small` (cosine similarity):

| Pair | Similarity |
| --- | --- |
| "How do I reset my password?" / "How can I reset my password?" | 0.961 |
| "How do I reset my password?" / "how do i reset my password" | 0.908 |
| "cancel my order" / "cancel my subscription" | 0.733 |
| "How do I reset my password?" / "I forgot my password, what should I do?" | 0.691 |
| "How do I reset my password?" / "How do I cancel my subscription?" | 0.468 |

A look-alike question with a different answer can score higher than a real paraphrase, so no threshold catches loose rewording without also serving wrong answers. The default of 0.92 only accepts close rewording. Lower it only after measuring on your own traffic.

## Options

| Option | Default | |
| --- | --- | --- |
| `pool` | required | A `pg.Pool`, or anything with `query` and `connect` |
| `embed` | required | `(text, { signal }) => Promise<number[]>` |
| `threshold` | `0.92` | Cosine similarity for a semantic hit |
| `ttl` | none | `"30s"`, `"15m"`, `"7d"`, ms, or `null` |
| `table` | `llm_cache_entries` | Must match `migrate()` |
| `lookupTimeoutMs` | `200` | Per database lookup, enforced on client and server |
| `embedTimeoutMs` | `5000` | For the embedding call, which is then aborted |
| `awaitStore` | `false` | Wait for the write on a miss; otherwise call `cache.flush()` before shutdown |
| `onError` | `console.warn` | `(error, stage)`, never receives prompt or response text |
| `onLookup` | none | `({ result, namespace, similarity })` for each lookup |

## Using your own migration tool

`renderMigrationSql({ table, dimensions })` returns the idempotent SQL that `migrate()` runs, to paste into Prisma, Drizzle or Flyway migrations.

## Development

```sh
pnpm install
pnpm test            # unit + integration; integration starts pgvector in Docker via Testcontainers
pnpm test:consumer   # packs the library and installs it into a fresh project
```

## Roadmap

- [x] v0.1: core lookup/store, OpenAI wrapper, SQL migration, tests against real Postgres
- [ ] v0.2: Anthropic wrapper, TTL/invalidation API, Prometheus metrics
- [ ] v0.3: Grafana dashboard, benchmark with published numbers
- [ ] later: streaming responses, per-namespace thresholds, admin CLI

## License

[MIT](LICENSE)
