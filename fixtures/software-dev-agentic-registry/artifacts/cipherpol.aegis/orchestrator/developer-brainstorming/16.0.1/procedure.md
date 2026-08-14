# Procedure — Brainstorming Ideas Into Designs

> **This file is not a skill.** It has no frontmatter and therefore no invocation
> gate, so any caller can execute it by loading it regardless of its own
> `disable-model-invocation` setting.
>
> Executed by:
> - `/developer-brainstorming` — standalone entry point
> - `/developer-brainstorm-build-feature` — Step 1
>
> Callers must pass the **Input** below. Nothing here is auto-substituted —
> `$ARGUMENTS` is not expanded in a file that is loaded rather than invoked.

## Input

| Input | Required | Meaning |
|---|---|---|
| `arguments` | no | The idea or topic to brainstorm. May be empty. |
| `on_approval` | yes | What happens after the user approves the spec — `build` (run the build workflow inline) or `stop` (emit the output block and return to the caller). If absent, treat as `stop`: handing back is always recoverable, building on a caller that did not ask for it is not. |


## Preflight — Resolve Working Context

Run before anything else. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

Skip if the caller already passed a resolved Working Context — resolve once per
session, never twice. Hold `project_root`, `platform`, `cp1_slug`, and `state_dir`
and pass all four in every agent spawn and every included procedure.

On `source=ambiguous`, present the `candidate=` lines via `AskUserQuestion` (one
option each, `label` = project, `description` = `<platform> · <path>`) and re-run
with `--repo=<chosen>`. On an `error=` line with no candidates, tell the user to
run `/aegis-setup-cipherpol` and stop. Then echo:

```
▸ <project> · <platform> · <project_root>
```

## Output

On spec approval, emit a `## Brainstorm Output` block containing `spec_path`.

---

Turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits
2. **Offer the visual companion just-in-time** — NOT upfront. The first time a question would genuinely be clearer shown than described, offer it then (its own message); on approval its browser tab opens for you. If no visual question ever arises, never offer it. See the Visual Companion section below.
3. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
4. **Propose 2-3 approaches** — with trade-offs and your recommendation
5. **Present design** — in sections scaled to their complexity, get user approval after each section
6. **Write design doc** — save to `.claude/agentic-state/developer/brainstorming/YYYY-MM-DD-<topic>-design.md` and commit
7. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
8. **User reviews written spec** — ask user to review the spec file before proceeding
9. **Transition** — emit `## Brainstorm Output`, then act on `on_approval` — see Transition section

## Process Flow

```dot
digraph brainstorming {
    "Explore project context" [shape=box];
    "Ask clarifying questions" [shape=box];
    "Propose 2-3 approaches" [shape=box];
    "Present design sections" [shape=box];
    "User approves design?" [shape=diamond];
    "Write design doc" [shape=box];
    "Spec self-review\n(fix inline)" [shape=box];
    "User reviews spec?" [shape=diamond];
    "Transition\n(per on_approval)" [shape=doublecircle];

    "Explore project context" -> "Ask clarifying questions";
    "Ask clarifying questions" -> "Propose 2-3 approaches";
    "Propose 2-3 approaches" -> "Present design sections";
    "Present design sections" -> "User approves design?";
    "User approves design?" -> "Present design sections" [label="no, revise"];
    "User approves design?" -> "Write design doc" [label="yes"];
    "Write design doc" -> "Spec self-review\n(fix inline)";
    "Spec self-review\n(fix inline)" -> "User reviews spec?";
    "User reviews spec?" -> "Write design doc" [label="changes requested"];
    "User reviews spec?" -> "Transition\n(per on_approval)" [label="approved"];
}
```

**The terminal state is the Transition step.** Whether it ends in a build or hands back to the caller is decided by `on_approval` — not by this procedure, and never by inferring who called it. Do NOT write code or scaffold before the user has approved the spec.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems, flag this immediately. Help the user decompose into sub-projects with their own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible
- Only one question per message — break topics into multiple questions if needed
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work, include targeted improvements as part of the design.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation:**

- Write the validated design (spec) to `<state_dir>/developer/brainstorming/YYYY-MM-DD-<topic>-design.md` — `state_dir` comes from the Working Context; do not resolve the root here
- Commit the design document to git

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

**Transition:**

Once the user approves the spec, emit the output block for the caller — on both paths, always:

```
## Brainstorm Output
spec_path: <spec-path>
```

Then act on the `on_approval` input. Route on its value alone — never on which skill loaded this file.

**`on_approval: stop`** → stop here. The caller runs the build itself.

**`on_approval: build`** → execute the build workflow inline. Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-build-feature/procedure.md"
```

Follow it end to end with `input_path` = `<spec-path>`. Do not ask the user to run it manually.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode.

**Offering the companion (just-in-time):** Do NOT offer it upfront. Wait until a question would genuinely be clearer shown than told — a real mockup / layout / diagram question, not merely a UI *topic*. The first time that happens, offer it then, as its own message:
> "This next part might be easier if I show you — I can put together mockups, diagrams, and comparisons in a browser tab as we go. It's still new and can be token-intensive. Want me to? I'll open it for you."

**This offer MUST be its own message.** Only the offer — no clarifying question, summary, or other content. Wait for the user's response. If they accept, start the server with `--open` so their browser opens to the first screen automatically. If they decline, continue text-only and don't offer again unless they raise it.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, scope decisions

If they agree to the companion, read the detailed guide before proceeding:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-brainstorming/visual-companion.md"
```

It contains the full server API, HTML templates, CSS classes, event format, and design tips.

**Starting the server:**

```bash
"$CLAUDE_PLUGIN_ROOT/skills/developer-brainstorming/scripts/start-server.sh" --project-dir /path/to/project --open
```

Save the `screen_dir` and `state_dir` from the JSON response. Share the complete URL (including `?key=…`) with the user.
