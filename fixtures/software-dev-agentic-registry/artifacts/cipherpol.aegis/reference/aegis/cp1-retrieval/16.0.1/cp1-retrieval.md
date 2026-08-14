> Related: [aegis-knowledge-load skill](../../skills/procedures/aegis-knowledge-load/SKILL.md) · [aegis-knowledge-lookup skill](../../skills/procedures/aegis-knowledge-lookup/SKILL.md) · [knowledge-output.md](./knowledge-output.md)

# cp-1 Knowledge Retrieval Protocol

The single protocol every aegis agent/skill follows to retrieve architectural
**knowledge** (theory, conventions, deviations, design-system catalogs) from the
`cipherpol-1` doc store via `search_docs`. Code *implementation* is still read
from the local checkout with `Grep`/`Read` — this protocol covers knowledge only.

---

## Server selection — default, then fallback

Two tool namespaces expose the identical `search_docs` tool:

| Order | Tool | What it is |
|---|---|---|
| 1 (default) | `mcp__plugin_cipherpol-1_cp1__search_docs` | Remote team server, shipped by the enabled `cipherpol-1` plugin |
| 2 (fallback) | `mcp__cp1-dev__search_docs` | Local stdio server over the toolkit source; only present on a dev machine |

**Rule:** call the plugin tool first. If it returns a connection error or a 401,
retry the **identical** call on `mcp__cp1-dev__search_docs`. If neither is
available, soft-fail (see each skill's soft-fail note) — never fabricate content.

---

## Addressing a knowledge node

`search_docs(slug, query, [platform], [doc_type], [status], [ref], [k])`

| Parameter | How to set it |
|---|---|
| `slug` | **Platform / universal knowledge** → `_global`. **Project-tier knowledge** → the project's cp-1 slug — the `cp1_slug` field of the Working Context passed in by the caller (e.g. `mobile-talenta`, `talenta-ios`, `flex-mobile`), resolved once per run by `aegis-resolve-context`. Empty `cp1_slug` → skip the project tier entirely. |
| `ref` | Docs are addressed by `docs:latest` — the default. Do not pass a code ref (`branch:*`) to `search_docs`. |
| `platform` | `["flutter"]` / `["ios"]` / `["android"]` / `["web"]` — the detected platform. Filters `_global` down to the right platform's docs. |
| `doc_type` | Engineering theory/conventions → `["standard"]`. Design-system catalogs → `["design"]`. Project tier → `["reference","standard"]` — `reference` covers deviations / feature-inventory / shared-components / api-endpoints, `standard` covers normative in-codebase rules such as `patterns`. Never filter the project tier to `reference` alone; it hides every project-tier standard. |
| `query` | Natural language. Fold the artifact / topic / pattern coordinates into the text — e.g. `"domain use case naming and dependency rules"`. There is **no** exact Knowledge-Path fetch; the query *is* the address. |
| `k` | Default 6; raise to scan a broader TOC, lower for a tight result set. |

Results carry a **heading breadcrumb** (`Standard Architecture > Domain > Use Case`)
and facet labels (`doc_type`, `platform`) — use these to confirm a chunk is the
node you meant, the same way a scoped TOC row used to.

---

## Cascade (project → platform)

The old `project → platform → universal` cascade becomes a two-step by `slug`:

1. **Project tier first** — `search_docs(slug=<cp1_slug>, query, doc_type=["reference","standard"])`.
   Deviations here *override* platform conventions; existing inventory here defines
   real boundaries; a project-tier `patterns` node is **binding** — when a reusable
   template exists for what you are building, conform to it instead of designing a
   new shape. Skip if no project slug resolved.
2. **Platform tier** — `search_docs(slug=_global, query, platform=[<platform>], doc_type=["standard"])`.

When a project deviation contradicts a platform standard, the deviation wins.

---

## Old → new call mapping

| Old cp-8 call | cp-1 replacement |
|---|---|
| `kms_list(...)` (TOC scan) | first broad `search_docs`; breadcrumbs are the TOC |
| `kms_fetch(discipline, artifact, topic, pattern, platform)` | `search_docs(slug, query="<artifact> <topic> <pattern>", platform, doc_type)` |
| `kms_query(text, ...)` | `search_docs(slug, query=text, platform, doc_type)` — native mode |
| project-tier `kms_list/kms_fetch(project, artifact=deviations/...)` | `search_docs(slug=<cp1_slug>, query, doc_type=["reference","standard"])` |
| design lookup (`discipline=design, area=design-system`) | `search_docs(slug=_global, query=<name>, platform, doc_type=["design"])` |
