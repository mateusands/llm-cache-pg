# llm-cache-pg

[English](README.md)

**Cache semântico para chamadas de LLM em TypeScript, sobre PostgreSQL puro + pgvector.** Roda em qualquer Postgres com pgvector (RDS, Supabase, Neon, self-hosted), sem extensão customizada para instalar. Envolve sua chamada à OpenAI ou à Anthropic em uma linha, isola os dados por tenant e exporta métricas para o Prometheus com um dashboard pronto do Grafana.

> **Status: v0.1, ainda não publicado no npm.** O cache, o wrapper da OpenAI e a migração estão implementados e testados contra Postgres real. Anthropic, métricas e o dashboard do Grafana vêm a seguir (veja o [Roadmap](#roadmap)). A API ainda pode mudar antes da 1.0.

---

## Por quê

Apps com LLM recebem a mesma pergunta com palavras diferentes o tempo todo. "How do I reset my password?" e "How can I reset my password?" não deveriam custar duas chamadas ao modelo.

Um cache semântico gera o embedding do prompt, procura uma pergunta parecida o bastante que já foi respondida e devolve a resposta guardada em vez de chamar o modelo.

As opções que existem não servem para uma stack típica de TypeScript + Postgres:

| Opção | Por que não serve |
| --- | --- |
| [pg_semantic_cache](https://github.com/pgedge/pg_semantic_cache) | Extensão de Postgres em C/PLpgSQL: exige `make install` e superusuário, então não roda em Postgres gerenciado. Sem integração do lado da aplicação. |
| [@upstash/semantic-cache](https://www.npmjs.com/package/@upstash/semantic-cache) | Preso ao Upstash Vector; último release em nov/2024. |
| GPTCache, RedisVL | Só Python. |

O `llm-cache-pg` vive na sua aplicação, usa o Postgres que você já tem e só precisa da extensão `vector`, que os provedores gerenciados já liberam.

**Requisitos:** Node 22+, PostgreSQL com pgvector 0.8+ (versões mais antigas funcionam, com buscas semânticas mais fracas em namespaces cheios). Sem dependências em runtime: você fornece o pool do `pg` e, se quiser, o client da `openai`.

## Funcionalidades

- **Busca exata + semântica:** primeiro por hash (grátis), depois por similaridade de vetor.
- **Wrapper de uma linha** para o SDK da OpenAI, mais um `cache.wrap(fn)` genérico.
- **Chaves seguras:** a requisição inteira faz parte da chave, menos a última mensagem do usuário, que é a única parte comparada por vetor. Modelo, system prompt, turnos anteriores, temperatura, tools e qualquer campo que o SDK adicione no futuro precisam bater exatamente.
- **Fail-open:** se o banco ou o embedder estiverem fora do ar ou lentos, a chamada vai direto para o modelo e o erro vai para o `onError`.
- **Multi-tenant** via `namespace`: nunca há hit entre tenants.
- **TTL** por cache ou por chamada; uma chave expirada volta a ser cacheada no próximo miss.
- **Traga seu embedder:** embeddings da OpenAI já incluídos, ou qualquer `(text, { signal }) => Promise<number[]>`.
- **Migração** como função ou como SQL puro para a sua ferramenta de migração, com índice HNSW.

Planejado: wrapper da Anthropic, API de invalidação, métricas para o Prometheus e dashboard do Grafana.

## Começo rápido

```ts
import pg from "pg";
import OpenAI from "openai";
import { createCache, migrate } from "llm-cache-pg";
import { openaiEmbedder, withCache } from "llm-cache-pg/openai";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI();

await migrate(pool, { dimensions: 1536 }); // idempotente, pode rodar em todo startup

const cache = createCache({
  pool,
  embed: openaiEmbedder({ client: openai, model: "text-embedding-3-small" }),
  threshold: 0.92, // similaridade de cosseno necessária para um hit semântico
  ttl: "7d",
});

// Opção 1: envolver o client
const ai = withCache(openai, cache, { namespace: tenantId });
const res = await ai.chat.completions.create({ model: "gpt-4.1-mini", messages });

// Opção 2: envolver qualquer chamada cujo resultado seja JSON
const answer = await cache.wrap(() => callSomeModel(messages), {
  namespace: tenantId,
  key: { model: "some-model", messages, params: { temperature: 0 } },
});

// No desligamento: esperar as gravações em segundo plano e fechar o pool
await cache.flush();
await pool.end();
```

Uma versão executável está em [examples/openai-basic](examples/openai-basic/index.ts): copie o `.env.example` para `.env`, coloque sua chave da OpenAI e rode `docker compose -f examples/docker-compose.yml up -d && pnpm example`.

## O que nunca é cacheado

- Requisições com streaming, `n > 1` ou áudio: vão direto para o SDK.
- Requisições cuja última mensagem não é do usuário ou tem partes que não são texto, como imagens.
- Respostas com tool calls ou com `finish_reason` diferente de `stop`.

Com o wrapper da OpenAI, uma resposta do cache volta como uma `Promise<ChatCompletion>` comum, então `.withResponse()` não está disponível em chamadas sem streaming.

## Escolhendo o threshold

Medido com `text-embedding-3-small` (similaridade de cosseno):

| Par | Similaridade |
| --- | --- |
| "How do I reset my password?" / "How can I reset my password?" | 0,961 |
| "How do I reset my password?" / "how do i reset my password" | 0,908 |
| "cancel my order" / "cancel my subscription" | 0,733 |
| "How do I reset my password?" / "I forgot my password, what should I do?" | 0,691 |
| "How do I reset my password?" / "How do I cancel my subscription?" | 0,468 |

Uma pergunta parecida, mas com outra resposta, pode ter nota maior que uma paráfrase de verdade. Por isso nenhum threshold pega reformulações soltas sem também servir respostas erradas. O default de 0,92 só aceita reformulações próximas. Baixe esse valor só depois de medir com o seu próprio tráfego.

## Opções

| Opção | Default | |
| --- | --- | --- |
| `pool` | obrigatório | Um `pg.Pool`, ou qualquer coisa com `query` e `connect` |
| `embed` | obrigatório | `(text, { signal }) => Promise<number[]>` |
| `threshold` | `0.92` | Similaridade de cosseno para um hit semântico |
| `ttl` | nenhum | `"30s"`, `"15m"`, `"7d"`, ms ou `null` |
| `table` | `llm_cache_entries` | Precisa ser a mesma do `migrate()` |
| `lookupTimeoutMs` | `200` | Por consulta ao banco, aplicado no client e no servidor |
| `embedTimeoutMs` | `5000` | Para a chamada de embedding, que é abortada depois disso |
| `awaitStore` | `false` | Esperar a gravação num miss; se não, chame `cache.flush()` antes de desligar |
| `onError` | `console.warn` | `(error, stage)`, nunca recebe o texto do prompt nem da resposta |
| `onLookup` | nenhum | `({ result, namespace, similarity })` a cada busca |

## Usando sua própria ferramenta de migração

`renderMigrationSql({ table, dimensions })` devolve o SQL idempotente que o `migrate()` executa, para colar em migrações do Prisma, Drizzle ou Flyway.

## Desenvolvimento

```sh
pnpm install
pnpm test            # unitários + integração; a integração sobe o pgvector no Docker via Testcontainers
pnpm test:consumer   # empacota a biblioteca e instala num projeto novo
```

## Roadmap

- [x] v0.1: busca e gravação, wrapper da OpenAI, migração SQL, testes contra Postgres real
- [ ] v0.2: wrapper da Anthropic, API de TTL/invalidação, métricas para o Prometheus
- [ ] v0.3: dashboard do Grafana, benchmark com números publicados
- [ ] depois: respostas com streaming, threshold por namespace, CLI de administração

## Licença

[MIT](LICENSE)
