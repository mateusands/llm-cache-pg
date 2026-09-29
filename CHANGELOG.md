# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change the API.

## [Unreleased]

### Fixed

- Two different requests could get the same cache key, and so the same answer: an own `__proto__` key was lost, and every `Date` (or other value with `toJSON`) hashed as `{}`. Keys now keep `__proto__`, follow `toJSON` like `JSON.stringify`, and plain JSON hashes exactly as before, so `KEY_VERSION` stays 1.
- An OpenAI stream replayed from the cache lost its `logprobs`, `system_fingerprint` and `service_tier`. They are now stored and replayed as `ChatCompletionStream` accumulates them.
- A key that cannot be built (a `BigInt` or a cycle in `params`) made `wrap()` reject instead of calling the model. It is now a bypass.

### Changed

- `params` values that are neither plain objects, arrays nor have `toJSON` (a `Map`, `Set`, `RegExp`, typed array or class instance) now bypass the cache instead of being hashed as `{}`. `invalidate({ key })` with such a key throws, as for any key that is never cached.

## [0.6.0] - 2026-09-28

### Added

- Anthropic streams with web search, web fetch or tool search are stored and replayed, tool input included.
- Shadow mode (`shadow: true` on the cache or per call): every request is looked up but the model is always called; `onShadow` receives each hit that would have been served next to the fresh answer. Misses are still stored. Counted in `llm_cache_shadow_lookups_total`, never as tokens saved.
- Grafana dashboard: shadow panels (would-have-hit ratio, shadow lookups by result). The metrics demo sends 10% of its traffic in shadow mode so they have data.
- `cache.stats()`: exact entry counts, expired entries, hits, table and index size, and the top namespaces and models. The CLI's `stats` uses it.

### Changed

- Anthropic answers that ran code (code execution, bash, text editor, container uploads) or carry a `container` are no longer stored, streamed or not. The container they point at expires, so a replay would hand back a dead id.

### Fixed

- The metrics demo mounted the dashboard as a single file, so Grafana kept serving the old version after an edit. It now mounts the folder.
- The similarity panel colored large bars red, which read as an error.

## [0.5.0] - 2026-09-28

### Added

- `llm-cache-pg` CLI: `migrate`, `stats`, `prune` and `invalidate` (a dry run unless `--yes`). Needs `pg`, now an optional peer dependency.
- `chat.completions.stream()` and `messages.stream()` go through the cache, through the SDKs' own helper classes, so their events, final message and abort work as usual.
- Anthropic streams with thinking, redacted thinking or citations are stored and replayed block for block. Streams with server tools are still not stored.
- The streaming form of the Anthropic wrapper's `create` has `withResponse()`, which `messages.stream()` needs; `response` and `request_id` are null on a cached answer.

### Fixed

- Aborting a stream replayed from the cache did not stop it: the replay ran to the end.

## [0.4.0] - 2026-09-28

### Added

- `threshold` and `semantic` per call, and `semantic` on the cache. With `semantic: false` only exact matches are served and no embedding is computed.
- Streaming: `create({ stream: true })` is cached in both wrappers. Finished streams are stored and replayed as a real SDK `Stream`; aborted, failed, truncated, tool-calling or non-text streams are not.
- `cache.lookup()`: a lookup whose handle stores the answer later, reusing the lookup's embedding. The stream support is built on it.
- Schema v2: `embedding` is optional, for exact-only entries. `migrate()` upgrades v1 tables in place without locking out readers.

### Changed

- `llm-cache-pg/openai` and `llm-cache-pg/anthropic` import their SDK at runtime (only the `Stream` class). The core and `llm-cache-pg/prometheus` still import nothing.
- The streaming overloads of `create` return a plain `Promise<Stream>`, not an `APIPromise`.

### Fixed

- The OpenAI and Anthropic wrappers could store an answer with no choices or no content blocks.

## [0.3.0] - 2026-09-28

First release on npm.

### Added

- `examples/metrics`: Postgres, Prometheus and Grafana in one compose file, with an app that generates traffic. Runs without API keys.
- `grafana/dashboard.json`: hit ratio, requests by result, tokens saved, lookup latency, similarity, errors and entries.
- Release workflow that publishes to npm with provenance from a version tag.

### Changed

- `llm_cache_lookup_duration_seconds` uses buckets from 0.5 ms to 5 s. The client defaults start at 5 ms, above a typical database lookup.

## [0.2.0] - 2026-09-28

Not published to npm.

### Added

- `llm-cache-pg/anthropic`: `messages.create` wrapper with the same contract as the OpenAI one. Input tokens include prompt-cache reads and writes.
- `cache.prune()` deletes expired entries in batches; `cache.invalidate()` deletes by namespace, model or exact key.
- `llm-cache-pg/prometheus`: requests, tokens saved, lookup latency, similarity, errors and entry count, with `@prometheus-io/client` or `prom-client`.
- Lookup events carry per-stage durations and, on hits, the stored token counts.
- `pnpm bench`: hit and false-hit rate per threshold on Quora Question Pairs and a PT/EN support set.
- CI runs the integration suite on pgvector 0.7.4 / Postgres 17 and 0.8.0 / Postgres 13.

## [0.1.0] - 2026-09-28

Not published to npm.

### Added

- Exact lookup by hash, then semantic lookup by cosine similarity within a partition of namespace, model and the whole request except the last user message.
- Fail-open lookups: database or embedder failures and timeouts fall through to the model and go to `onError`.
- `migrate()` and `renderMigrationSql()` with configurable table and dimensions.
- `llm-cache-pg/openai`: chat completions wrapper and embedder.
- `cache.flush()` to wait for background writes before shutdown.

[Unreleased]: https://github.com/mateusands/llm-cache-pg/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mateusands/llm-cache-pg/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mateusands/llm-cache-pg/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mateusands/llm-cache-pg/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mateusands/llm-cache-pg/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mateusands/llm-cache-pg/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mateusands/llm-cache-pg/releases/tag/v0.1.0
