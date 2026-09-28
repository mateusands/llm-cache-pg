# llm-cache-pg

[Português](README.pt-BR.md)

**Semantic cache for LLM calls in TypeScript, backed by plain PostgreSQL + pgvector.** Runs on any Postgres that has pgvector (RDS, Supabase, Neon, self-hosted) with no custom extension to install. Wraps your OpenAI or Anthropic call in one line, isolates data per tenant, and exports Prometheus metrics.

> **Status: v0.5.** Pre-1.0: the API may still change between minor versions (see the [changelog](CHANGELOG.md)).

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

**Requirements:** Node 22+, PostgreSQL with pgvector 0.8+ (older pgvector works, with weaker semantic lookups in busy namespaces). No runtime dependencies in the core: you bring the `pg` pool and, optionally, an SDK client. CI runs the integration suite on pgvector 0.8.6 / Postgres 18, 0.8.0 / Postgres 13 and 0.7.4 / Postgres 17.

## Features

- **Exact + semantic lookup:** hash match first (free), vector similarity second.
- **One-line wrappers** for the OpenAI and Anthropic SDKs, plus a generic `cache.wrap(fn)`.
- **Safe cache keys:** the whole request is part of the key except the last user message, which is the only part compared by vector. Model, system prompt, earlier turns, temperature, tools and any field the SDK adds later all have to match exactly.
- **Fail-open:** if the database or the embedder is down or slow, your call goes straight to the model and the error goes to `onError`.
- **Multi-tenant** via `namespace`: no cross-tenant hits.
- **TTL** per cache or per call, `prune()` for expired entries and `invalidate()` by namespace, model or key.
- **Prometheus metrics** through `llm-cache-pg/prometheus`, with either `@prometheus-io/client` or `prom-client`.
- **Bring your own embedder:** OpenAI embeddings built in, or any `(text, { signal }) => Promise<number[]>`.
- **Migration** as a function or as plain SQL for your own migration tool, with an HNSW index.

A Grafana dashboard and a runnable metrics demo are included.

## Quick start

```sh
npm install llm-cache-pg pg
npm install openai               # or @anthropic-ai/sdk, for the wrappers
```

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

// Same for Anthropic. Using both? Alias one:
// import { withCache as withAnthropicCache } from "llm-cache-pg/anthropic";

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

- `n > 1` and audio requests: passed straight to the SDK.
- Requests whose last message isn't from the user, or has non-text parts such as images.
- Responses with tool calls, or that didn't finish normally (`finish_reason` other than `stop`; `stop_reason` other than `end_turn` or `stop_sequence`).

With either wrapper, results come back as plain Promises, so `.withResponse()` isn't available. With Anthropic, stored token counts include prompt-cache reads and writes.

### Streaming

`create({ stream: true })` and the SDK helpers `chat.completions.stream()` and `messages.stream()` go through the cache too. On a miss you get the SDK's stream untouched, and the answer is stored once the stream has ended normally. On a hit you get a real SDK `Stream` that replays the stored answer, so `for await`, `tee()` and `toReadableStream()` work as usual.

- Nothing is stored if the stream is aborted, fails, is cut short or calls tools. Anthropic streams with thinking, redacted thinking or citations are stored and replayed block for block; streams with server tools (web search, code execution) are not, although the same answer without streaming is. Stopping with a `break` counts as cut short, even on the final chunk.
- Streamed and plain requests are cached separately.
- Replays send the whole answer in one content chunk rather than token by token.
- On a cached answer through Anthropic's `messages.stream()`, `request_id` is null and the helper's `withResponse()` throws: there is no HTTP response behind it.

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

Both the threshold and semantic lookups can be set per call, so each tenant or route gets its own:

```ts
// A narrow FAQ bot that you have measured:
const faq = withCache(openai, cache, { namespace: "faq", threshold: 0.88 });
// Open-ended questions: exact repeats only. No embedding calls, no false hits.
const chat = withCache(openai, cache, { namespace: tenantId, semantic: false });
```

Exact-only entries are stored without an embedding, which needs the schema from `migrate()` in 0.4 or later.

## Benchmark

1000 question pairs from [Quora Question Pairs](https://huggingface.co/datasets/nyu-mll/glue) (validation split, 326 labelled duplicates), run through the library against Postgres 18 + pgvector 0.8.6. Each pair's first question is stored, then the second one is looked up. **Hit rate** is the share of duplicate pairs answered from the cache; **false-hit rate** is the share of served answers whose pair is labelled *not* a duplicate.

| Threshold | Hit rate (3-small) | False-hit rate (3-small) | Hit rate (3-large, 2000 dims) | False-hit rate (3-large) |
| --- | --- | --- | --- | --- |
| 0.85 | 46.3% (151) | 24.0% (53) | 47.5% (155) | 18.8% (39) |
| 0.90 | 29.1% (95) | 20.3% (26) | 25.2% (82) | 21.0% (22) |
| **0.92** (default) | **20.6% (67)** | **19.5% (17)** | **20.6% (67)** | **15.0% (12)** |
| 0.94 | 14.7% (48) | 14.3% (8) | 14.1% (46) | 14.8% (8) |
| 0.96 | 8.0% (26) | 10.3% (3) | 6.7% (22) | 12.0% (3) |

How to read it:

- The false-hit rate is an upper bound. Quora's labels are noisy: of 8 "false hits" above 0.94 checked by hand, about half were really the same question ("What brand of socks is this?" / "…are these?"). The rest were real wrong answers, such as "How do I migrate my **Clash Royale** account…" served for "…my **Clash of Clans** account…" at 0.956.
- A look-alike question can score as high as a real paraphrase, so raising the threshold lowers false hits slowly while hits drop fast. Semantic hits pay off on narrow, repetitive traffic (support, FAQ) where you can check the answers; on open-ended questions, rely on exact hits.
- On a small hand-written support set (`bench/data/faq.json`, 10 paraphrases and 10 look-alikes per language), the default 0.92 answered 1/10 English paraphrases with 3-small and 0/10 with 3-large, 0/10 Portuguese ones with either, and served none of the 20 look-alikes. Illustrative only, given the size.
- Lookup cost on a warm local database: exact p50 0.4 ms, semantic p50 1.3 ms / p95 1.8 ms with 1536 dimensions (7.8 / 9.3 ms with 2000).

Reproduce with `pnpm bench` (needs Docker and `OPENAI_API_KEY`; embeddings are cached in `bench/.cache`). Raw results are in [bench/results](bench/results). The Quora data is downloaded, not redistributed.

## Options

| Option | Default | |
| --- | --- | --- |
| `pool` | required | A `pg.Pool`, or anything with `query` and `connect` |
| `embed` | required | `(text, { signal }) => Promise<number[]>` |
| `threshold` | `0.92` | Cosine similarity for a semantic hit; also per call |
| `semantic` | `true` | `false` for exact matches only, with no embedding calls; also per call |
| `ttl` | none | `"30s"`, `"15m"`, `"7d"`, ms, or `null` |
| `table` | `llm_cache_entries` | Must match `migrate()` |
| `lookupTimeoutMs` | `200` | Per database lookup, enforced on client and server |
| `embedTimeoutMs` | `5000` | For the embedding call, which is then aborted |
| `awaitStore` | `false` | Wait for the write on a miss; otherwise call `cache.flush()` before shutdown |
| `onError` | `console.warn` | `(error, stage)`, never receives prompt or response text |
| `onLookup` | none | `({ result, namespace, similarity })` for each lookup |

## Metrics

```ts
import * as client from "@prometheus-io/client"; // or "prom-client"
import { prometheusHooks } from "llm-cache-pg/prometheus";

const cache = createCache({ pool, embed, ...prometheusHooks({ client, pool }) });
```

| Metric | Type | Labels |
| --- | --- | --- |
| `llm_cache_requests_total` | counter | `result`: exact_hit, semantic_hit, miss, bypass; `namespace` if `namespaceLabel: true` |
| `llm_cache_tokens_saved_total` | counter | `direction`: in, out |
| `llm_cache_lookup_duration_seconds` | histogram | `stage`: exact, embed, semantic |
| `llm_cache_similarity` | histogram | none; best score of each semantic lookup |
| `llm_cache_errors_total` | counter | `stage` |
| `llm_cache_entries` | gauge | `table`; from Postgres statistics, only when `pool` is given |

A Grafana dashboard is in [grafana/dashboard.json](grafana/dashboard.json). To see it with live traffic, no API key needed:

```sh
pnpm build && docker compose -f examples/metrics/docker-compose.yml up
# open http://localhost:3000
```

![Grafana dashboard with the demo running](grafana/dashboard.png)

The demo sends synthetic support questions through the cache with a fake model and a fake embedder, so its hit ratio says nothing about real traffic. With `OPENAI_API_KEY` in `.env` it uses OpenAI embeddings (`DEMO_OFFLINE=1` forces the fakes); the model stays fake.

The hooks replace `onError`, so errors are counted instead of logged; wrap them if you want both. The namespace label is off by default, since one series per tenant can overload Prometheus.

## Cleaning up

```ts
await cache.prune();                              // delete expired entries, in batches of 1000
await cache.invalidate({ namespace: tenantId });  // everything for one tenant
await cache.invalidate({ model: "gpt-4.1-mini" }); // after a model upgrade
await cache.invalidate({ key: { model, messages }, namespace: tenantId }); // one bad answer
```

Run `prune()` on a schedule when you use a TTL; expired entries are never served, but they stay in the table until then. Both calls throw on failure, unlike lookups. After deleting many rows, a `VACUUM` lets Postgres reuse the space in the HNSW index.

### From the command line

The same operations, plus stats, without writing a script (needs `pg` installed; the connection comes from `DATABASE_URL` or `--url`):

```sh
npx llm-cache-pg migrate --dimensions 1536
npx llm-cache-pg stats            # entries, expired, hits, size, top namespaces and models; --json for scripts
npx llm-cache-pg prune
npx llm-cache-pg invalidate --namespace tenant-a         # dry run: prints how many entries it would delete
npx llm-cache-pg invalidate --namespace tenant-a --yes   # deletes them
```

Every command takes `--table`. Exit codes: 0 on success, 1 on a failure, 2 on bad usage. The connection URL is never printed.

## Using your own migration tool

`renderMigrationSql({ table, dimensions })` returns the idempotent SQL that `migrate()` runs, to paste into Prisma, Drizzle or Flyway migrations.

## Development

```sh
pnpm install
pnpm test            # unit + integration; integration starts pgvector in Docker via Testcontainers
pnpm test:consumer   # packs the library and installs it into a fresh project
PGVECTOR_IMAGE=pgvector/pgvector:0.7.4-pg17 pnpm test:integration  # another pgvector/Postgres
pnpm bench           # benchmark (Docker + OPENAI_API_KEY)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Roadmap

- [x] v0.1: core lookup/store, OpenAI wrapper, SQL migration, tests against real Postgres
- [x] v0.2: Anthropic wrapper, prune/invalidate, Prometheus metrics, pgvector version matrix, benchmark
- [x] v0.3: Grafana dashboard, metrics demo, npm release
- [x] v0.4: streaming responses, per-call threshold, exact-only mode
- [x] v0.5: SDK `.stream()` helpers, streams with thinking and citations, admin CLI
- [ ] later: streams with server tools, `cache.stats()` in the API

## License

[MIT](LICENSE)
