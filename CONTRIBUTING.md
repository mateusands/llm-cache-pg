# Contributing

Thanks for taking the time. This is a small library with a deliberately narrow scope: caching plain request → response LLM calls on Postgres. Bug reports, benchmark results on your own traffic and focused pull requests are welcome. For anything larger than a fix, please open an issue first so we can agree on the shape before you write code.

## Setup

Requirements: Node 22+, pnpm (the version is pinned in `package.json`), and Docker for the integration tests.

```sh
pnpm install
pnpm test            # unit + integration; starts pgvector in Docker via Testcontainers
pnpm lint            # Biome; `pnpm format` fixes most issues
pnpm typecheck
pnpm build
pnpm test:consumer   # packs the library and installs it into a fresh project
```

Run the integration suite against another pgvector or Postgres version with:

```sh
PGVECTOR_IMAGE=pgvector/pgvector:0.7.4-pg17 pnpm test:integration
```

CI runs the full suite on Node 22, 24 and 26, and the integration suite on pgvector 0.7.4 / Postgres 17 and 0.8.0 / Postgres 13.

## How the code is organized

| Path | What lives there |
| --- | --- |
| `src/key.ts` | How a request becomes a cache key |
| `src/store.ts` | All SQL |
| `src/cache.ts` | `createCache` and the lookup flow |
| `src/migrate.ts` | The schema, as a function and as SQL |
| `src/openai.ts`, `src/anthropic.ts` | SDK wrappers, published as subpaths |
| `src/prometheus.ts` | Metrics hooks, published as a subpath |
| `src/cli.ts`, `bin/` | The `llm-cache-pg` command; `bin/` only calls `runCli` |
| `bench/` | The benchmark (`pnpm bench`, needs `OPENAI_API_KEY`) |

## Rules the code relies on

Please keep these in mind; a change that breaks one of them needs a very good reason and a note in the pull request.

- **A false hit is worse than a miss.** The partition key is the whole request except the last user message. New fields are part of the key by default; a field is only left out after checking that it cannot change the answer.
- **The cache fails open.** Lookups never throw to the caller: database or embedder failures and timeouts go to `onError`, and the request reaches the model. Admin calls (`prune`, `invalidate`, `migrate`) do throw.
- **No runtime dependencies in the core.** `pg` and the Prometheus client are typed structurally. Each provider entry (`./openai`, `./anthropic`) imports only its own SDK, which its users already have, for its `Stream` class and stream helpers; the CLI imports only `pg`. `pnpm test:consumer` checks every bundle's imports.
- **Tests use a real Postgres.** Don't mock the database; mock only what is external, such as the model client. If a test asserts that something does *not* happen, check that it fails when the code does it.
- **Comments explain what the code can't:** a constraint, a trap already hit, a unit. One line is the default.

## Pull requests

- Keep each pull request to one change, with tests. If it changes behavior users can see, update both `README.md` and `README.pt-BR.md`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): what changes`, describing the effect rather than the file.
- Before opening it, run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Reporting a bug

Include the library version, Node version, Postgres and pgvector versions (`SELECT extversion FROM pg_extension WHERE extname = 'vector'`), what you ran, what you expected and what happened. Please leave prompts, answers and keys out of the report.
