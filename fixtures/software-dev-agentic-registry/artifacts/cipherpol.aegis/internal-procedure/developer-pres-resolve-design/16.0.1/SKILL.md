---
name: developer-pres-resolve-design
description: Resolve UI element descriptions against the cp-1 design-system catalogs (doc_type=design). Returns a Design System Bindings table (matched) and a Custom Widgets table (unmatched). Soft-fails with empty tables if cp-1 has no design-system docs for the platform.
user-invocable: false
---

Retrieval protocol (server selection, slug/ref/doc_type, fallback):
```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md"
```

## Input

| Parameter | Description |
|---|---|
| `artifact_name` | Name of the Screen or Component artifact from plan.md |
| `ui_description` | UI elements to resolve — use Figma section content when available, otherwise plan.md artifact description |
| `platform` | Platform slug (e.g. `flutter`) — passed through to `search_docs` as the `platform` filter |

## Steps

### 1 — Confirm the design system exists + fetch its metadata

`search_docs(slug="_global", query="design system metadata import prefix", platform=["{platform}"], doc_type=["design"], k=3)`

If nothing returns — **soft fail**: return empty tables with note `no design-system docs in cp-1 for {platform}`.

Otherwise, from the returned `# Metadata` chunk of each design-system library, record its **Import** path and component-name **Prefix** (e.g. Mekari Pixel: Import=`package:mekari_pixel/mekari_pixel.dart`, Prefix=`Mp`). Cache per-library for Step 3's output.

### 2 — Match each UI element

Parse `ui_description` into individual keyword phrases (e.g. `"primary button, avatar, list tile"` → `["primary button", "avatar", "list tile"]`).

For each keyword:
`search_docs(slug="_global", query="{keyword}", platform=["{platform}"], doc_type=["design"], k=3)`

Take the top result **only if** its heading breadcrumb / symbol name plausibly matches the keyword (e.g. `"primary button"` → `Mekari Pixel > Atoms > MpButton`). Read its description, key params, variants, and Figma link; pick the best variant by description. If no result is plausible, mark the keyword as unmatched.

### 3 — Source fallback (on-demand)

If a matched entry's key params are insufficient for the creation skill (e.g., a variant is referenced but its constructor is unclear), resolve the source path:
- `Grep` for `mekari_pixel:` in `pubspec.lock` to find the pub-cache hash
- Construct path: `~/.pub-cache/git/mekari-pixel-<hash>/mekari-pixel/lib/src/<widget_file>.dart`
- `Grep` for the class name → `Read(offset=<line>, limit=60)` to capture the full constructor

Include source path in the binding row only when used.

### 4 — Output

For each matched row, use the Prefix and Import cached in Step 1 for that element's matched library — rows matched against different libraries use their own library's Prefix/Import.

Return exactly:

```
## Design System Bindings

| UI element | Symbol | Variants | Import |
|---|---|---|---|
| <keyword> | `<Prefix><Name>` | <variant list or —> | `<Import>` |

## Custom Widgets

| UI element | Reason | Action |
|---|---|---|
| <keyword> | no catalog match | create custom widget |
```

Omit a table entirely if it has no rows. If both tables are empty, add a single note:
`no UI elements resolved — check ui_description input`
