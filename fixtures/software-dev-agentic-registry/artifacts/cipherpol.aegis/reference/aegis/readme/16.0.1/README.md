# Reference Taxonomy

This directory contains shared Reference docs — extracted formats, patterns, and contracts loaded on demand by workers and planners. See [Reference vs Knowledge](../../../../docs/principles/agentic/agentic-design-principles.md#reference-vs-knowledge) for how this differs from cp-1-managed Knowledge. Read this file before adding a new reference doc or deciding where a piece of knowledge belongs.

---

## What Belongs in Reference

A piece of knowledge belongs here if it passes all three tests:

1. **Fact, not instruction** — it can be stated without saying "you". Invariants, contracts, architectural rules, naming conventions.
2. **Shared** — more than one agent or worker needs it.
3. **Stable** — it changes when the architecture changes, not when a workflow changes.

If it only makes sense addressed to a specific agent ("before writing, check X"), it belongs in the agent body, not here.

---

## What Belongs in the Agent Body

Keep in the agent if:

- It is execution behavior: when to run, what to check, what to do on failure
- It is decision logic specific to that agent's workflow
- It references the agent's own preconditions, skill routing, or output format

---

## What Belongs in Skills

Keep in skills if:

- It is step-by-step procedural instructions for writing a specific artifact
- It contains platform-specific syntax, file templates, or code examples
- It is only relevant during the act of writing, not during planning or review

---

## Directory Structure

```
lib/core/aegis/reference/
  README.md              ← this file — taxonomy and placement rules

lib/core/<persona>/reference/
  <topic>.md             ← persona-scoped reference docs (language-agnostic)

lib/platforms/<platform>/reference/
  domain.md              ← platform-specific entity/use case patterns
  data.md                ← platform-specific DTO/mapper/datasource patterns
  presentation.md        ← platform-specific StateHolder + screen patterns
  navigation.md          ← platform-specific navigation/coordinator patterns
  di.md                  ← platform-specific DI wiring
  index.md               ← index of all reference files for this platform
```

`lib/core/aegis/reference/` and `lib/core/<persona>/reference/` docs are language-agnostic — no code syntax, no framework names as rules.
`lib/platforms/<platform>/reference/` docs contain code examples and are linked only to that platform.

---

## How Agents Use This Directory

- Thin format/contract docs — `Read` in full at the fixed path; these files are short by design
- Catalog files (`<name>-catalog.md`, if added under a persona's `reference/`) — `symbol-query` only (`Grep <name>` → `Read(offset, limit=60)`), never `Read` in full
- If uncertain which file covers a topic, Grep `reference/index.md` (platform level) or this README first
- After adding a new reference file, add an entry to the relevant `index.md` and this README's directory map
