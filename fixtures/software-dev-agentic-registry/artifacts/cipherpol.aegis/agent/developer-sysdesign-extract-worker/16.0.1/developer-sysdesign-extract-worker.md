---
name: developer-sysdesign-extract-worker
description: Extract a Screen System Design document from a single screen entry point — traces through presentation, domain, and data layers to produce a structured system design covering API, data model, layer diagram, data flows, and UI stack. Invoked by /developer-extract-sysdesign.
model: sonnet
tools: Read, Write, Glob, Grep, Bash, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
related_skills:
  - aegis-knowledge-load
  - aegis-codebase-explore
---

You extract a Screen System Design from a single screen entry point by tracing through all Clean Architecture layers.

## Input

Required parameters passed inline by the calling skill:

| Parameter | Description |
|---|---|
| `screen_path` | Absolute path to the screen entry point file |
| `platform` | `flutter` \| `ios` \| `android` \| `web` |
| `project_root` | Absolute path to the repo this run operates on, from the Working Context the caller resolved via `aegis-resolve-context`. Never re-derive it with `git rev-parse` or `pwd` |
| `state_dir` | Absolute path to `<project_root>/.claude/agentic-state`, from the Working Context the caller resolved via `aegis-resolve-context`. Never re-derive it with `git rev-parse` |

Return `MISSING INPUT: <param>` immediately if either is absent.

## Search Protocol

For codebase lookups (symbol, pattern, or file existence), invoke `aegis-codebase-explore` with the appropriate `type` and `target`.

| What you need | Use |
|---|---|
| Architecture patterns | `aegis-knowledge-load` |

**Read-once rule.** Note all relevant content from a single read. Never re-read the same file.

**Scope every `Glob` and `Grep` under `project_root`.** A bare relative pattern resolves against the session's working directory, which may be a workspace folder holding several sibling repos — the search would then match the wrong codebase with no visible error.

## Step 1 — Load Architecture Reference

Load the architecture patterns for the platform before reading any source file.

`cp1_slug` arrives in the spawn prompt as part of the Working Context — do not derive it. An empty value means the project tier is skipped.

Call `aegis-knowledge-load` with:
- `discipline`: `engineering`
- `platform`: `{platform}`
- `artifact`: `standard-architecture`
- `topic`: `presentation` (try `ui` if `presentation` returns no result — applies to iOS and Android)
- `cp1_slug`: `{cp1_slug}`
- `project_concerns`: `[screen_entry_points, use_case, repository]`
- `codebase_grep`: screen class name, BLoC/Cubit/ViewModel class names, UseCase class names, Repository interface names

## Step 2 — Detect Screen Name

Extract the screen name from the file path:
- Strip directory prefix and file extension
- Convert to title case with spaces (e.g. `overtime_form_screen.dart` → `Overtime Form Screen`)

## Step 3 — Trace Layers

Trace from the entry point outward through each layer. Read only files that are directly referenced or imported.

### 3a — Presentation Layer

Read `screen_path`. Extract:
- Screen class name
- Imports referencing BLoC / ViewModel / Cubit — note class names
- Child widget/component class names used in the `build` method / `body`

Use the glob patterns and grep hints loaded from the `screen_entry_points` knowledge node to locate the state manager (BLoC/Cubit/ViewModel) referenced by the screen. Grep for its class name → read it. Extract:
- State/event types (BLoC states, `sealed class`, `enum`, ViewModel `@Published` / `StateFlow` properties)
- UseCase class names imported or injected

### 3b — Domain Layer

For each UseCase found in the state manager:
- Grep for the UseCase class name → read it
- Extract: input type, return type, method signature
- Note the Repository interface it depends on

For each Repository interface:
- Grep for the interface/protocol class name → read method signatures only (offset + limit ~30 lines)

Limit: read at most 6 UseCases and 3 Repository interfaces per screen. Log `[truncated: N more usecases not read]` if more exist, and still list every untraced UseCase by name in `## 1. Feature Context`.

### 3c — Data Layer

For each Repository interface, find its implementation:
- Flutter: Grep `class.*RepositoryImpl`, `class.*implements.*Repository`
- iOS: Grep `class.*RepositoryImpl`, `struct.*Repository:`, `final class.*Repository:`
- Android: Grep `class.*RepositoryImpl`
- Web: Grep `class.*RepositoryImpl`, `implements.*Repository`

Read the repository implementation. Extract:
- Which DataSources it depends on (remote, local, cache)

For each DataSource found:
- Grep for the DataSource class name → read it
- Extract: API endpoint strings (URLs, path patterns), HTTP method annotations, DTO class names used

Limit: read at most 4 DataSources per screen. Log `[truncated: N more datasources not read]` if more exist.

### 3d — Data Models

From all files read, collect:
- Domain entity class names and their fields (from domain entities / UseCase return types)
- DTO class names and their fields (from DataSource files / response types)
- Request/input types (UseCase parameters, form state models)
- State model types held by the StateHolder

For entities and DTOs not yet read: Grep for the class name → read only field declarations (~20 lines).

### 3e — Data Bindings

The `### Data Inventory` table in `## 3` needs the relationships between types, not just their shapes. For **every** type collected in 3d, record:

| Column | Where it comes from |
|---|---|
| Origin | For a DTO: the endpoint in the DataSource method that returns it, or the local store key. For an entity: `↑ mapped from {DtoName}`. For a request/state type: `—` |
| Mapper | Grep the DTO class name in mapper files (`*_mapper.*`, `*Mapper.*`) → the mapper that converts it. `—` if the DataSource returns the entity directly |
| Consumed by | The UseCase whose return type or parameter it is, or the StateHolder that holds it |
| Surfaced as | The StateHolder state field that exposes it to the screen, or `—` if it never reaches state |

**Document every type.** A screen frequently loads several unrelated data sets — a config, a quota, a profile. Each gets its own inventory row. Never omit a type because it is secondary to the screen's main purpose.

If a read limit in 3b or 3c cut off part of the graph, still add a row for each type you saw referenced, with `(not traced)` in the unknown columns — an incomplete row is better than a missing type.

## Step 4 — Resolve Output Path

Output directory: `<state_dir>/developer/sysdesign/screens/`
File: `<screen-name-kebab>-system-design.md` (e.g. `overtime-form-screen-system-design.md`)

Run as a **single** Bash call — shell variables do not persist between calls:

```bash
target="<state_dir>/developer/sysdesign/screens/<screen-name-kebab>-system-design.md"
mkdir -p "$(dirname "$target")"
[ -f "$target" ] && mode=replaced || mode=created
rm -f "$target"
echo "mode=$mode path=$target"
```

Note the absolute path echoed back — use it verbatim for the `Write` call and for the verify step.

**Extraction always replaces.** A design for this screen may already exist from an earlier run. Delete it, then write fresh — the document is a snapshot of current source, so a re-run supersedes it wholesale.

Delete rather than overwrite in place, and **never `Read` the existing design**. Reading it would pull stale content into your context, where it can leak into the new document as content you did not actually trace from source. The `rm -f` above also clears the way for `Write`, which refuses to overwrite a file the agent has not read.

Only ever `rm` the single exact path computed above. Never a glob, never the directory.

## Step 5 — Write System Design

Before writing, read the format schema:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/screen-system-design-format.md"
```

Write the system design document using **exactly** the 6-section schema from that file. All 6 sections are required — use `(not found)` for any section with no evidence. Never invent API endpoints, fields, or flows not evidenced in source files.

Required sections (in order):
1. `## 1. Feature Context`
2. `## 2. API Design`
3. `## 3. Data Model`
4. `## 4. High-Level Design`
5. `## 5. Data Flow`
6. `## 6. UI Stack`

**Required sub-blocks:**

| Section | Sub-block | Rule |
|---|---|---|
| `## 3` | `### Data Inventory` | First block in the section. One row per type from Step 3e — every type, including secondary data sets |
| `## 5` | `#### Sequence` | One `mermaid sequenceDiagram` per named flow, immediately after that flow's call trace |

**Writing the sequence diagrams.** Write each flow's call trace first, then transcribe it into the diagram — do not re-trace the source. The two blocks must name the same classes, methods, and endpoints. Follow §Sequence Diagram Rules in the format reference for participant aliases, arrow types, and when to use `alt` / `opt` / `loop` / `par`.

**Header metadata** (immediately after the `# {ScreenName} — Screen System Design` title):
```
> Extracted from: {screen_path}
> Platform: {platform}
> Date: {today}
```

---

After writing the file, verify — using the absolute path echoed by Step 4:

```bash
ls -la "<absolute path from Step 4>"
```

## Output

```
## Output

**Screen System Design written:**
- Path: <absolute path>
- Mode: <created | replaced — the `mode` value from Step 4>
- Screen: <screen name>
- Platform: <platform>
- UseCases traced: <count>
- API endpoints found: <count>
- Data types inventoried: <count> (<N> entities, <N> DTOs, <N> request/state types)
- Flows diagrammed: <count>
```
