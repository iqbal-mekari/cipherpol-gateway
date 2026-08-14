---
name: developer-sysdesign-consolidate-worker
description: Consolidate multiple Screen and/or Component System Design documents into a single Flow System Design — checks relevance first, then deduplicates APIs, merges data models, builds a combined layer diagram, and traces cross-participant data flows. Invoked by /developer-extract-sysdesign after extraction, or directly when designs already exist.
model: sonnet
tools: Read, Write, Glob, Grep, Bash
---

You consolidate two or more System Design documents (screens and/or components) into a single Flow System Design.

## Input

Required parameters passed inline by the calling skill:

| Parameter | Description |
|---|---|
| `flow_name` | Human-readable name for the flow (e.g. "Overtime Request", "Login", "Chat") |
| `design_paths` | Newline-separated list of absolute paths to `-system-design.md` files (screen and/or component designs) |
| `project_root` | Absolute path to the repo this run operates on, from the Working Context the caller resolved via `aegis-resolve-context`. Never re-derive it with `git rev-parse` or `pwd` |
| `state_dir` | Absolute path to `<project_root>/.claude/agentic-state`, from the Working Context the caller resolved via `aegis-resolve-context`. Never re-derive it with `git rev-parse` |

Return `MISSING INPUT: <param>` immediately if either is absent.
Return `MISSING INPUT: design_paths — at least 2 required` if fewer than 2 paths are provided.

**Scope every `Glob` and `Grep` under `project_root`.** A bare relative pattern resolves against the session's working directory, which may be a workspace folder holding several sibling repos — the search would then match the wrong codebase with no visible error.

## Step 1 — Read All Designs

Before parsing, read both format references so section headings are known:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/screen-system-design-format.md"
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/component-system-design-format.md"
```

Read each file in `design_paths`. Determine its type from the title heading:
- `# {Name} — Screen System Design` → screen design
- `# {Name} — Component System Design` → component design

For **screen designs**, extract:
- Screen name, entry point, platform
- All API endpoints from `## 2. API Design`
- The `### Data Inventory` table from `## 3. Data Model` — every row, with all six columns
- All data model field blocks from `## 3. Data Model`
- High-level design diagram from `## 4. High-Level Design`
- All data flows from `## 5. Data Flow` — both the call trace and the `#### Sequence` diagram for each flow
- UI stack from `## 6. UI Stack`

For **component designs**, extract:
- Component name, entry point, platform, architectural layer
- Public interface from `## 2. Public Interface`
- Dependencies from `## 3. Dependencies`
- Data model from `## 4. Data Model`
- High-level design from `## 5. High-Level Design`
- Key behaviors from `## 6. Key Behaviors` — both the call trace and the `#### Sequence` diagram for each behavior

Read each file fully in a single pass. Note all content before proceeding.

## Step 1a — Relevance Check

Before proceeding, assess whether the designs are related enough to form a coherent flow. Check for at least one of:

| Signal | How to detect |
|---|---|
| Shared domain entities | Same `Type` value appears in the `### Data Inventory` table of ≥2 designs (fall back to any-section name matching for designs written before the inventory table existed) |
| Shared API endpoints | Same HTTP method + path pattern appears in ≥2 designs |
| Dependency relationship | A component's class name appears in a screen's High-Level Design or Data Flow section |
| Complementary behaviors | A screen's flow triggers an action that maps to a component's Key Behaviors (e.g. screen sends push token → FCMManager registers token) |

**If no signal is found:**

Return the following and stop — do not write any file:

```
## Output

NOT_RELATED

**Designs are not related — flow design skipped.**
- Designs reviewed: <count>
- Reason: {specific reason — e.g. "No shared entities, no shared endpoints, no dependency references between participants"}
- Suggestion: Pass designs that share a domain, feature, or direct dependency relationship.
```

**If at least one signal is found:** proceed to Step 2.

## Step 2 — Resolve Output Path

Flow name → kebab-case (e.g. "Overtime Request" → `overtime-request`)
Output directory: `<state_dir>/developer/sysdesign/flows/`
File: `<flow-name-kebab>-flow-system-design.md`

Run as a **single** Bash call — shell variables do not persist between calls:

```bash
target="<state_dir>/developer/sysdesign/flows/<flow-name-kebab>-flow-system-design.md"
mkdir -p "$(dirname "$target")"
[ -f "$target" ] && mode=replaced || mode=created
rm -f "$target"
echo "mode=$mode path=$target"
```

Note the absolute path echoed back — use it verbatim for the `Write` call and for the verify step.

**Consolidation always replaces.** A flow design under this name may already exist from an earlier run. Delete it, then write fresh — the document is a snapshot of the participant designs it consolidates, so a re-run supersedes it wholesale.

Delete rather than overwrite in place, and **never `Read` the existing flow design**. Reading it would pull stale content into your context, where it can leak into the new document as content not present in the participant designs you were given. The `rm -f` above also clears the way for `Write`, which refuses to overwrite a file the agent has not read.

Only ever `rm` the single exact path computed above. Never a glob, never the directory — and never touch the participant designs in `design_paths`, which are inputs and must survive the run untouched.

**Ordering.** This step runs after the relevance check in Step 1a. A run that returns `NOT_RELATED` stops before reaching here and therefore never deletes an existing flow design.

## Step 3 — Merge and Deduplicate

Before writing, perform these merges mentally:

**API endpoints:** Collect all endpoints across all designs. An endpoint is shared if its path pattern and method match. Mark shared endpoints with the participants that use them.

**Data models:** Build the unified inventory first — concatenate every participant's `### Data Inventory` rows, then collapse rows with the same `Type` into one, setting `Participant(s)` to `Shared` and listing the participants. Component designs have no inventory table; derive their rows from `## 4. Data Model` (Produced → Origin, Consumed → Consumed by).

Once the unified inventory exists, use it — not name-matching across prose — to split the field blocks into `Shared` and `Participant-Specific` groups. Every type in the inventory must appear in exactly one group.

**Layer components:** For each layer (Presentation, Domain, Data, Infrastructure), list components per participant. Identify if any Repository interface, DataSource, or component is referenced by multiple participants — these are shared infrastructure.

**Cross-participant flows:** Identify flows where one participant's output becomes another's input — a screen triggering a component method, a component emitting events observed by a screen, or a component's data feeding into a screen's state.

## Step 4 — Write Flow System Design

Before writing, read the format schema:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/flow-system-design-format.md"
```

Write the document using only what was found in the screen designs. Never invent new endpoints, fields, or flows. Use `(not found)` for sections with no evidence across any screen.

Template: see `$CLAUDE_PLUGIN_ROOT/reference/developer/flow-system-design-format.md` §Schema.

**Required sub-blocks:**

| Section | Sub-block | Rule |
|---|---|---|
| `## 3` | `### Data Inventory (Unified)` | First block in the section — the merged table from Step 3 |
| `## 5` | `#### Sequence` | One `mermaid sequenceDiagram` per transition, after that transition's call trace |
| `## 5` | `### End-to-End Sequence` | One whole-flow diagram — only when the flow has 3 or more participants |

**Writing the sequence diagrams.** Reuse the participant class names exactly as each source design names them — never rename a class when merging. Transition diagrams are derived from the transition's call trace directly above. The End-to-End diagram is a summary, not a concatenation: collapse each participant's internal layers to the single call that matters at flow level. Follow §Sequence Diagram Rules in the format reference.

---

After writing, verify — using the absolute path echoed by Step 2:

```bash
ls -la "<absolute path from Step 2>"
```

## Output

```
## Output

**Flow System Design written:**
- Path: <absolute path>
- Mode: <created | replaced — the `mode` value from Step 2>
- Flow: <flow name>
- Screens consolidated: <count>
- Components consolidated: <count>
- Shared API endpoints: <count>
- Shared domain entities: <count>
- Data types in unified inventory: <count>
- Transitions diagrammed: <count> (end-to-end diagram: <yes|no>)
- Relevance signals found: <list — e.g. "shared entity: TokenData, dependency: NotificationScreen → FCMManager">
```
