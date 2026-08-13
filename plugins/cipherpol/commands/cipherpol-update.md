---
description: Check or explicitly activate a compatible Cipherpol runtime
allowed-tools: Bash
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/cipherpol-local update "$@"`. Preserve `--check` as read-only. Never add `--yes`; only the consumer may provide explicit non-interactive confirmation. After activation, instruct the consumer to run `/reload-plugins`.
