---
name: developer-type-check
description: Run the platform type-checker after all artifacts are complete, fix all reported errors in a single pass, and re-run once to confirm clean. Never loops more than twice.
user-invocable: false
allowed-tools: Bash, Grep, Read
---

## Input

| Parameter | Description |
|---|---|
| `platform` | `flutter`, `ios`, or `web` |
| `package_path` | Absolute path to the package root |

## Steps

1. Run the platform type-checker:

| platform | command |
|---|---|
| flutter | `flutter analyze {package_path}` |
| web | `npx tsc --noEmit` (run from `{package_path}`) |
| ios | skip — no fast static analyzer available; type errors surface at build time |

2. Capture the full output — do not truncate.
3. For each error: locate the actual definition with `Grep`, then `Read` around it. **Never fix by guessing** — wrong parameter names must be corrected by reading the actual constructor or type definition.
4. Fix all reported errors in a single pass, then re-run once to confirm clean.
5. Never loop more than twice — if errors persist, surface them to the user with the exact error output.
