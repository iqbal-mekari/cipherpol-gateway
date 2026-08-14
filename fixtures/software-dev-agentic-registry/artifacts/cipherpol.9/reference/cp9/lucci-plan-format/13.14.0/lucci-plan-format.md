# Plan Document Format

Single source of truth for the `plan.md` schema used by the cp9-rob-lucci plan-then-build flow — written by `cp9-fukurou-planner`, consumed by `cp9-kaku-worker` and `cp9-rob-lucci`.

---

## Schema

```markdown
# Plan: <short title>

## Goal
<what success looks like, in 1-3 sentences>

## Context
<key files, existing patterns, and constraints discovered during exploration>

## Steps
1. <step description> — `<file path(s)>`
2. ...

## Files Affected
| Path | Change |
|---|---|
| <path> | create / modify / delete — <what changes> |

## Open Questions
(omit section entirely if none)
- <question>

## Risks / Notes
(omit section entirely if none)
- <risk or note>
```

---

## Section Contracts

| Section | Required | Written by | Read by | Purpose |
|---|---|---|---|---|
| `## Goal` | always | cp9-fukurou-planner | user | One-line success criteria shown during review |
| `## Context` | always | cp9-fukurou-planner | user | Exploration findings — why the plan looks this way |
| `## Steps` | always | cp9-fukurou-planner | cp9-kaku-worker | Ordered execution list |
| `## Files Affected` | always | cp9-fukurou-planner | cp9-kaku-worker | Verification checklist after build |
| `## Open Questions` | conditional | cp9-fukurou-planner | cp9-rob-lucci | If present, triggers a clarification + `revise` round before Approve/Discuss/Cancel is offered |
| `## Risks / Notes` | conditional | cp9-fukurou-planner | user | Surfaced during review, no automated handling |
