---
name: developer-validate-artifact-output
description: Validate that a written artifact exists on disk and contains its primary symbol. Run after each artifact write, before moving to the next.
user-invocable: false
allowed-tools: Glob, Grep
---

## Input

| Parameter | Description |
|---|---|
| `artifact_name` | Human-readable name for the artifact (used in failure messages) |
| `file_path` | Absolute path to the written file |
| `primary_symbol` | Primary class or function name to Grep for inside the file |

## Steps

1. `Glob` for `file_path` — if not found: STOP. Do not continue to the next artifact.
2. `Grep` for `primary_symbol` inside the file — confirms content was written correctly.
3. If either check fails: report `artifact_name`, expected `file_path`, and what was missing. Ask the user whether to retry, fix manually, or skip.
