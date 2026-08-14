> Related: [aegis-knowledge-load skill](../../skills/procedures/aegis-knowledge-load/SKILL.md) · [cp1-retrieval.md](./cp1-retrieval.md)

Standard output format produced after every `aegis-knowledge-load` call. Agents emit this block; orchestrators and calling skills can parse it by heading.

---

## Format

~~~
## Knowledge Loaded — {discipline}/{artifact}

### Theory
{Knowledge from cp-1 search_docs — definitions, patterns, naming conventions, dependency rules.
One entry per matched doc chunk; label each with its heading breadcrumb (e.g. `Standard Architecture > Domain > Use Case`).}

### Code Pattern
{file: <path>}
{excerpt — constructor, class signature, or representative method body.
Enough to match naming and structural style; not the full file.}
~~~

---

## Rules

- Always emit both `### Theory` and `### Code Pattern`. If either is unavailable, state why:
  - No cp-1 content: `Theory: no docs found for {artifact}/{topic} on {platform} — refine the search_docs query or check cp-1 connectivity`
  - `discipline: product` with nothing in the project tier: `Theory: no product docs (prd/spec) for {artifact} in {cp1_slug}` — this is an expected state, not a connectivity problem. Most projects have no PRDs ingested yet; proceed on the ticket/PRD passed inline by the caller.
  - No codebase match: `Code Pattern: no match for "{codebase_grep}" outside test paths`
- One `## Knowledge Loaded` block per `aegis-knowledge-load` call. Two calls → two blocks, each labelled with their own `{discipline}/{artifact}`.
- Do not forward raw search_docs JSON. Summarise into human-readable pattern descriptions.
- Theory and Code Pattern together are the ground truth for all artifact decisions in the current session. An agent that skips either is operating on incomplete knowledge.
