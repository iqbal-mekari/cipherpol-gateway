---
name: qa-debug-patrol-selector
description: Diagnose one failing Patrol selector via the live native tree and return a confirmed fix. Called by qa-debug-worker.
user-invocable: false
---

Diagnose and fix exactly one failing Patrol selector — never a full testcase rewrite.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/patrol-selector-rules.md`. STOP and report a reference gap if missing.
2. Call `mcp__patrol__native-tree` to inspect the live view hierarchy — the sole diagnostic tool; never `mcp__patrol__screenshot`.
3. If the tree output is ambiguous (no stable text or identifier), read the screen source for `Key(...)` / `Semantics(identifier: ...)`.
4. Derive the corrected finder by walking the selector priority hierarchy in `patrol-selector-rules.md` (text → key/Semantics → ancestor chaining → containing → new Semantics).
5. Edit the failing file with the corrected finder and re-run via `patrol develop` hot-restart (`r`) to confirm the fix on the live device. Do not retry the same failing selector a second time — if it fails again, move to the next strategy in the hierarchy or stop and report.

## Rules

- Never use pixel coordinates as a fix.
- Never use screenshots for investigation.
- Inspect and fix only the specific failing element — do not rewrite the surrounding testcase or scenario.
- The edit made in Step 5 is the confirmed fix in place — there is no separate apply step.

## Output

Root cause (one line), failing snippet, fixed snippet, test result (confirmed / not confirmed), and whether a Semantics change is required (yes/no — if yes, the exact `Semantics(identifier: ..., container: true, child: ...)` block added).
