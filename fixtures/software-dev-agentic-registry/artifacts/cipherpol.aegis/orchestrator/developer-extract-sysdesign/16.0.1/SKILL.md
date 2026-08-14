---
name: developer-extract-sysdesign
description: Extract a System Design document from one or more screen or component entry points, or consolidate existing system designs into a flow design. Single file → Screen or Component System Design. Multiple files → parallel extraction then Flow System Design (if designs are related). Multiple existing .md designs → consolidation only.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash
---

## Routing Contract

This skill is a pure router. Its only permitted direct operations:
- `Bash` — verify worker output paths exist. The root is **not** resolved here: `project_root` and `state_dir` come from the Working Context (Step 0)
- `AskUserQuestion` — ask for flow name when consolidating multiple designs

Existing designs are detected and replaced by the workers, not here. Never delete or overwrite a design file directly.

Never read source files, grep, or explore — all code reading and writing is done by workers.

## Input

Arguments passed after `/developer-extract-sysdesign`:

| Pattern | Classified as |
|---|---|
| Source file path(s) — `.dart`, `.swift`, `.kt`, `.tsx`, `.ts`, `.vue` | Screen or component entry point(s) → extract |
| File path(s) ending in `-system-design.md` | Existing designs → consolidate only |
| No arguments | Error — ask for input |

If no arguments are provided, call `AskUserQuestion`:

```
question    : "Provide one or more source file paths (e.g. login_screen.dart, fcm_manager.dart) or existing -system-design.md files to process."
header      : "Input"
```

Stop if the user does not provide valid paths.

## Step 0 — Resolve Working Context

Run before anything else. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

Hold `project_root`, `platform`, `cp1_slug`, and `state_dir` for the whole run and
pass all four in every agent spawn. On `source=ambiguous`, present the `candidate=`
lines via `AskUserQuestion` (one option each, `label` = project, `description` =
`<platform> · <path>`) and re-run with `--repo=<chosen>`. On an `error=` line with
no candidates, tell the user to run `/aegis-setup-cipherpol` and stop. Then echo:

```
▸ <project> · <platform> · <project_root>
```

## Step 1 — Classify Inputs

Parse arguments. Classify each path by extension:
- `extracted_paths` → source files (`.dart`, `.swift`, `.kt`, `.tsx`, `.ts`, `.vue`)
- `provided_md_paths` → existing system design files (`*-system-design.md`)

For each source file, detect platform from extension:
- `.dart` → `flutter`
- `.swift` → `ios`
- `.kt` → `android`
- `.tsx`, `.ts`, `.vue` → `web`

For each source file, classify as **screen** or **component** from the filename (no file reading):

| Platform | Screen patterns | Component patterns |
|---|---|---|
| flutter | `*_screen.dart`, `*_page.dart` | everything else (e.g. `*_manager.dart`, `*_service.dart`, `*_datasource.dart`) |
| ios | `*ViewController.swift`, `*Screen.swift`, `*View.swift` | everything else |
| android | `*Activity.kt`, `*Fragment.kt`, `*Screen.kt` | everything else |
| web | `*Page.tsx`, `*Screen.tsx`, `*Page.ts`, `*View.vue` | everything else |

## Step 2 — Extract (skip if no source files)

Spawn one worker per source file **in parallel** (single Agent call), routing by classification:

- **Screen** → spawn `developer-sysdesign-extract-worker` with:
  ```
  screen_path: <absolute path>
  platform: <detected from extension>
  ```

- **Component** → spawn `developer-sysdesign-component-extract-worker` with:
  ```
  component_path: <absolute path>
  platform: <detected from extension>
  ```

Wait for all workers. Each returns `## Output` with the written design path and a `Mode:` of `created` or `replaced`. Collect all paths as `new_design_paths`, keeping each path's mode.

**Re-runs replace.** A worker whose target design already existed deletes it and writes fresh — extraction is a snapshot of current source, so the newer run always wins. This is unconditional and there is no backup; surface every `replaced` so the user knows a previous design was superseded.

**Validate each returned path:**
- Must end in `-system-design.md` (e.g. `overtime-form-screen-system-design.md`) — naming convention violation if it does not
- Must exist on disk (`ls <path>`) — worker output error if it does not

If any worker fails, returns an invalid path, or returns a path that does not exist, surface the failure — do not silently skip.

## Step 3 — Route on Total

Collect `all_paths = new_design_paths + provided_md_paths`.

**If `len(all_paths) == 1`:**
Surface the output path to the user, using the worker's mode:
```
System design <written|replaced>: <path>
```
Done.

**If `len(all_paths) > 1`:**
Ask for a flow name:

```
question    : "What should this flow be called? This becomes the title of the consolidated Flow System Design (e.g. 'Push Notification Setup', 'Login', 'Overtime Request')."
header      : "Flow Name"
```

Spawn `developer-sysdesign-consolidate-worker`:

```
flow_name: <user input>
design_paths:
  - <path 1>
  - <path 2>
  ...
```

Wait for the worker to return `## Output`.

**If the worker returns `NOT_RELATED`:**
Surface to the user:
```
Flow design skipped — designs are not related.
<reason from worker output>
```
Done.

**If the worker returns a written flow design:**
Surface the flow design path:
```
Flow system design <written|replaced>: <path>
Participants consolidated: <screens count> screen(s), <components count> component(s)
Relevance signals: <from worker output>
Designs replaced this run: <list of paths whose mode was `replaced`, or "none">

Note: the provided `-system-design.md` inputs are read-only and are never modified.
```
