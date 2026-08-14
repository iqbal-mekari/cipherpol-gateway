---
name: aegis-knowledge-load
description: Load knowledge for a domain scope — given discipline + layer + artifact + topic coordinates, searches the cp-1 doc store for matching knowledge, checks the project tier for deviations, and explores the codebase. Call once per knowledge domain; call twice for two domains.
user-invocable: false
allowed-tools: Grep, Read, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
---

Retrieval protocol (server selection, slug/ref/doc_type, cascade, old→new mapping):
```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md"
```

## Input

| Parameter | Required | Description |
|---|---|---|
| `discipline` | Yes | `engineering`, `design`, or `product` — selects the doc types each tier searches. See the mapping below. |
| `platform` | Yes | Platform slug — `flutter`, `ios`, `android`, `web` |
| `layer` | No | CLEAN layer scope — `domain`, `data`, or `presentation`. Fold into the query to bias results to that layer plus cross-cutting knowledge. Omit for cross-layer work (e.g. app/wiring). |
| `artifact` | No | Artifact name — e.g. `standard-architecture`, `conventions`. Fold into the query text. |
| `topic` | No | Topic — e.g. `domain`, `data`. Fold into the query text. |
| `cp1_slug` | No | Project cp-1 slug for project-tier lookup — e.g. `mobile-talenta`. Omit to skip the project tier. |
| `project_concerns` | No | Project-tier concerns to check — e.g. `deviations`, `feature-inventory`, `patterns`. Each becomes a `doc_type=["reference","standard"]` query; skipped if nothing returns. |
| `codebase_grep` | Yes | Grep pattern for existing implementation — e.g. `class.*UseCase`, `class.*RepositoryImpl` |
| `codebase_exclude` | No | Paths to exclude from codebase Grep. Default: `test/`, `mock/`, `fake/` |

### Discipline → doc types

| `discipline` | Project tier | Platform tier |
|---|---|---|
| `engineering` | `["reference","standard"]` | `["standard"]` |
| `design` | `["reference","standard"]` | `["design"]` |
| `product` | `["prd","spec","reference","standard"]` | **skipped** — see below |

`product` covers requirements-side knowledge: acceptance criteria, feature
specifications, user stories. That knowledge is **always project-scoped** — a
feature's acceptance criteria belong to one product, never to a platform — so
`_global` holds none of it and the platform tier is skipped rather than run and
discarded. `prd` and `spec` are included in the project tier because they are the
cp-1 doc types such content lands in; they are skipped silently when a project has
none, exactly like any other empty concern.

Any other `discipline` value is an input error: return
`MISSING INPUT: discipline — expected engineering | design | product`.

## Steps

### 1 — Project tier first (if `cp1_slug` provided)

For each concern in `project_concerns`:
`search_docs(slug="{cp1_slug}", query="{concern} {artifact} {topic} {layer}", doc_type=<per the table above>, platform=["{platform}"])`.
If nothing relevant returns, skip.

The project tier holds two kinds of node and **both** must be in scope — filtering to `reference` alone silently hides the second:

- `reference` — deviations, feature-inventory, shared-components, api-endpoints. Deviations **override** platform conventions; inventory nodes define existing boundaries.
- `standard` — normative in-codebase rules, notably `patterns` (reusable templates a new feature must conform to rather than reimplement).

Carry both forward and prefer them over the platform tier on conflict. A project-tier `patterns` hit is binding: if a template exists for the thing being built, the plan uses it.

### 2 — Platform tier

**Skip this step entirely when `discipline` is `product`** — `_global` carries no
requirements-side knowledge, so the query returns only low-scoring engineering and
design-system noise. Go straight to step 3.

`search_docs(slug="_global", query="{artifact} {topic} {layer} — <the concepts this task needs>", platform=["{platform}"], doc_type=<per the table above>)`.

Reason over the returned chunks — use the heading breadcrumbs (e.g. `Standard Architecture > Domain > Use Case`) to confirm relevance. Do not accept a chunk whose breadcrumb/facets don't match the scope. If the first query is too broad or misses a needed concept, refine the `query` and search again — the query is the address (there is no exact-path fetch).

### 3 — Codebase explore

`Grep` for `{codebase_grep}` in source, excluding `{codebase_exclude}` paths → read the most complete match (most method definitions, fewest TODO stubs) as live code reference.

## Output

Before writing, read the format schema:
```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/aegis/knowledge-output.md"
```

Produce a `## Knowledge Loaded` block as defined there. Always both Theory and Code Pattern — never one without the other.
