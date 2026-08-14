# Figma Group Format

> Related: developer-figma-group-worker.md (writer); developer-ui-worker.md, developer-pres-planner.md (readers)

Schema for UIStack artifacts written by `developer-figma-group-worker` and the output block returned to the orchestrating skill.

---

## `figma-uistack-<screen-slug>.md` — Screen UI Stack

One file per screen cluster and one per overlay/dialog cluster, synthesized by merging all state frames belonging to that cluster. Modeled on `screen-system-design-format.md` §6 (UI Stack).

```markdown
---
screen: <ScreenName>
type: screen | overlay
parent_screen: <ScreenName>   # only present when type: overlay
also_shown_from: [<ScreenName>, ...]   # only present when type: overlay and invoked from more than one screen
states:
  - state: <state name>
    file: <abs path to figma-<slug>.md>
    layout_source: <figma_url>
    screenshot: <abs path to figma-<slug>-screenshot.png>
  - ...
overlays: [<figma-uistack-*.md filename>, ...]   # only present when type: screen and one or more overlay clusters reference it as parent_screen
---

## <ScreenName> — UI Stack

### State Model
| State | Key Differences |
|---|---|
| <state> | <what changes visually vs other states — content, loading indicator, error banner, empty illustration, etc.> |

### Component Hierarchy

```
{ScreenClass}
  ├── {LoadingComponent}        ← state is <state>
  ├── {ErrorComponent}          ← state is <state>
  └── {ContentComponent}        ← state is <state>
        ├── {ChildComponent}
        └── {OverlayComponent}  ← see figma-uistack-<overlay-slug>.md
```

### Design Tokens

#### Colors
- <token>: <value>

#### Typography
- <token>: <value>

#### Spacing / Layout
- <container or component>: <axis>, gap <value>, padding <value>

### User Interactions
| Interaction | Triggers | Effect |
|---|---|---|
| <e.g. "Tap retry"> | <event/handler name from Interactions field> | <effect> |

### Localizations

#### Static Text
| Key | Value | Context | Component |
|---|---|---|---|
| <suggested_snake_case_key> | "<string>" | <e.g. "AppBar title", "SectionHeader", "BlankSlate heading", "CTA"> | <dot-path in hierarchy — e.g. "Stage.Content.ListTile-AddRow.Label"> |

#### Value / Placeholder Text
| Key | Value | Context | Component |
|---|---|---|---|
| <suggested_snake_case_key> | "<string>" | <e.g. "Field label", "Placeholder", "Error message", "Picker option"> | <dot-path in hierarchy> |
```

### Field Contracts

| Field | Read by | Purpose |
|---|---|---|
| `states` (frontmatter) | pres-planner, ui-worker | Maps each branch of the Component Hierarchy back to its source frame's `.md` / `layout_source` / `screenshot` |
| `type`, `parent_screen`, `overlays` | pres-planner, ui-worker | Distinguishes standalone screens from overlay components (dialogs, filters, bottom sheets) and links them to their host screen |
| `Component Hierarchy` | pres-planner, ui-worker | Single merged tree across all states — primary structural reference for Screen/Component artifacts |
| `State Model`, `User Interactions` | pres-planner, feature-worker | Source for StateHolder state fields and event cases |
| `Design Tokens` (Colors, Typography, Spacing/Layout) | ui-worker | Token mapping and layout constraints during UI build |
| `Localizations` | feature-worker, l10n tooling | Static string catalog — key names feed directly into ARB/strings files |

---

## `## Figma Groups` Block

Returned by `developer-figma-group-worker` after all fetch workers for a run have completed:

```
## Figma Groups
ds_available: true | false
ds_artifacts: [<design-system artifact names found — e.g. mekari-pixel>]   # omit when ds_available: false
groups:
  - screen: <cluster name derived from visual structure>
    type: screen | overlay
    parent_screen: <ScreenName>   # only present when type: overlay
    also_shown_from: [<ScreenName>, ...]   # only present when type: overlay and invoked from more than one screen
    uistack_file: <abs-path-to-figma-uistack-*.md>
    states:
      - state: <inferred state name>
        file: <abs-path-to-figma-*.md>
        layout_source: <figma_url>
        screenshot: <abs-path-to-figma-*-screenshot.png>
review:
  - frame: <figma-*.md filename>
    reason: <one line — e.g. "Visually ambiguous between X and Y — placed by parent_frame hint">
```

Omit `review` entirely if no frames needed tiebreaking. Omit `ds_available`/`ds_artifacts` entirely if `platform` was not provided.
