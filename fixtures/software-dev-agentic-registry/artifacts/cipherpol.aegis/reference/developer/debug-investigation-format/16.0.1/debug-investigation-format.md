# Debug Investigation Format

> Author: Puras Handharmahua · 2026-06-22
> Related: developer-debug-strategist.md

Output contract for `developer-debug-strategist` — written to `.claude/agentic-state/runs/developer/debug/<timestamp>-<slug>.md` and updated each convergence round.

---

## File Structure

```markdown
# Debug Investigation: <slug>
Started: <timestamp>

## Round <N> — <datetime>

### Hypothesis
<what the strategist believes is causing the bug>

### Evidence
<code references, stack traces, or patterns that support or refute the hypothesis>

### Log Analysis
<interpretation of available logs — "none" if no logs were provided this round>

### Conclusion
<what was confirmed, ruled out, or remains uncertain — and what to instrument next>

---

## Root Cause
<filled only when converged — concise statement of the confirmed root cause>

## Fix Recommendation
<filled only when converged — concrete steps or code changes to resolve the bug>
```

---

## Rules

- Create the file on round 1. Append a new `## Round <N>` section on every subsequent round — never overwrite prior rounds.
- `Root Cause` and `Fix Recommendation` sections are written only when the strategist has sufficient evidence to converge. Leave them absent until then.
- Timestamp format: `YYYYMMDD-HHmmss` for the filename; ISO 8601 (`2026-06-22T14:03:00`) for `Started:` and round headers.
- Slug is kebab-case derived from the bug description, max 5 words (e.g. `payment-screen-null-pointer`).
