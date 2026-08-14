---
name: developer-sysdesign-component-extract-worker
description: Extract a Component System Design document from a single component file (manager, service, repository, datasource, etc.) — reads the public interface, traces dependencies, and produces a structured system design covering purpose, public interface, dependencies, data model, high-level design, and key behaviors. Invoked by /developer-extract-sysdesign.
model: sonnet
tools: Read, Write, Glob, Grep, Bash, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
related_skills:
  - aegis-knowledge-load
  - aegis-codebase-explore
---

You extract a Component System Design from a single component file by reading its public interface, tracing its dependencies, and documenting its key behaviors.

## Input

Required parameters passed inline by the calling skill:

| Parameter | Description |
|---|---|
| `component_path` | Absolute path to the component file |
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
- `topic`: `infrastructure` (try `data` if `infrastructure` returns no result)
- `cp1_slug`: `{cp1_slug}`
- `project_concerns`: `[use_case, repository, datasource]`
- `codebase_grep`: component class name, any injected dependency class names visible from file name

## Step 2 — Detect Component Name

Extract the component name from the file path:
- Strip directory prefix and file extension
- Convert to title case with spaces (e.g. `fcm_manager.dart` → `FCM Manager`, `location_service.dart` → `Location Service`)

Infer architectural layer from class name suffix:

| Suffix | Layer |
|---|---|
| `Manager` | Infrastructure |
| `Service` | Domain Service or Infrastructure |
| `Repository`, `RepositoryImpl` | Data |
| `DataSource`, `RemoteDataSource`, `LocalDataSource` | Data |
| `Helper`, `Util`, `Utils` | Infrastructure |
| `Provider` | Infrastructure or Presentation |
| Other | Infrastructure (default) |

## Step 3 — Read Component File

Read `component_path`. Extract:
- Class name and architectural layer (confirm or correct inference from Step 2)
- All public methods/functions: name, parameters, return type
- All public properties/streams/publishers: name, type
- Constructor / `init` parameters — these are the injected dependencies
- Any event streams, callbacks, or delegates emitted to callers
- Platform SDK calls or third-party package usages (e.g. `FirebaseMessaging`, `CoreLocation`, `Geolocator`)

## Step 4 — Trace Dependencies

For each dependency identified in the constructor / injection:
- Grep for the dependency class name → read its class declaration only (~20 lines)
- Note: its role, what it provides to this component
- Do NOT trace the dependency's own dependencies

For native/platform SDK dependencies (e.g. `FirebaseMessaging`, `Geolocator`):
- Note as "Native API / Package — {platform SDK or package name}"
- Do not attempt to read SDK source files

Limit: trace at most 4 dependencies. Log `[truncated: N more dependencies not traced]` if more exist.

## Step 5 — Identify Key Behaviors

From the source file, identify 2–5 named behaviors worth documenting:
- **Initialization** — what happens when the component is created/started
- **Primary flows** — the main method(s) callers invoke and what they trigger
- **Event emission** — when and how the component notifies callers (streams, callbacks, delegates)
- **Error handling** — how failures are surfaced to callers
- **Lifecycle** — disposal, cleanup, background/foreground transitions (if present)

Only document behaviors with evidence in the source file. Do not invent behaviors.

## Step 6 — Resolve Output Path

Output directory: `<state_dir>/developer/sysdesign/components/`
File: `<component-name-kebab>-system-design.md` (e.g. `fcm-manager-system-design.md`)

Run as a **single** Bash call — shell variables do not persist between calls:

```bash
target="<state_dir>/developer/sysdesign/components/<component-name-kebab>-system-design.md"
mkdir -p "$(dirname "$target")"
[ -f "$target" ] && mode=replaced || mode=created
rm -f "$target"
echo "mode=$mode path=$target"
```

Note the absolute path echoed back — use it verbatim for the `Write` call and for the verify step.

**Extraction always replaces.** A design for this component may already exist from an earlier run. Delete it, then write fresh — the document is a snapshot of current source, so a re-run supersedes it wholesale.

Delete rather than overwrite in place, and **never `Read` the existing design**. Reading it would pull stale content into your context, where it can leak into the new document as content you did not actually trace from source. The `rm -f` above also clears the way for `Write`, which refuses to overwrite a file the agent has not read.

Only ever `rm` the single exact path computed above. Never a glob, never the directory.

## Step 7 — Write System Design

Before writing, read the format schema:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/component-system-design-format.md"
```

Write the system design document using **exactly** the 6-section schema from that file. All 6 sections are required — use `(not found)` for any section with no evidence. Never invent methods, dependencies, or behaviors not evidenced in source files.

Required sections (in order):
1. `## 1. Component Purpose`
2. `## 2. Public Interface`
3. `## 3. Dependencies`
4. `## 4. Data Model`
5. `## 5. High-Level Design`
6. `## 6. Key Behaviors`

**Required sub-blocks:**

| Section | Sub-block | Rule |
|---|---|---|
| `## 6` | `#### Sequence` | One `mermaid sequenceDiagram` per named behavior, immediately after that behavior's call trace |

**Writing the sequence diagrams.** Write each behavior's call trace first, then transcribe it into the diagram — do not re-trace the source. The two blocks must name the same classes and methods. Participants are the component plus its dependencies from `## 3. Dependencies`, named exactly as that table names them. Follow §Sequence Diagram Rules in the format reference.

**Header metadata** (immediately after the `# {ComponentName} — Component System Design` title):
```
> Extracted from: {component_path}
> Platform: {platform}
> Date: {today}
```

---

After writing the file, verify — using the absolute path echoed by Step 6:

```bash
ls -la "<absolute path from Step 6>"
```

## Output

```
## Output

**Component System Design written:**
- Path: <absolute path>
- Mode: <created | replaced — the `mode` value from Step 6>
- Component: <component name>
- Platform: <platform>
- Layer: <architectural layer>
- Dependencies traced: <count>
- Key behaviors documented: <count>
- Behaviors diagrammed: <count>
```
