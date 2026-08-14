# Layer Contracts

> Related: developer-feature-intent-strategist.md, developer-feature-convergence-strategist.md, developer-domain-planner.md, developer-data-planner.md, developer-pres-planner.md, developer-app-planner.md

Canonical layer dependency rules, artifact types, and planner selection logic for Clean Architecture feature planning.

---

## Dependency Direction

`Domain ← Data ← Presentation ← UI` — each layer imports only from the layer to its left.

## Layer Artifacts and Creation Order

| Layer | Artifacts | Creation order |
|---|---|---|
| Domain | Entity, Repository Interface, Use Case, Domain Service | Entity → Repository Interface → Use Case(s) → Domain Service (if needed) |
| Data | DTO, Mapper, DataSource interface + impl, Repository impl | DTO → Mapper → DataSource interface → DataSource impl → Repository impl |
| Presentation | StateHolder, State, Event/Input, Action/Output | Use Cases → StateHolder → StateHolder contract |
| UI | Screen, Component, Navigator/Coordinator, DI wiring | Screen → Navigator/Coordinator (if needed) → DI wiring (if needed) |

## Inter-layer Imports

| Consumer | May import from |
|---|---|
| Domain | nothing |
| Data | Domain only |
| Presentation | Domain only (use cases, entities) |
| UI | Presentation only (StateHolder contract) |

## Planner Selection Table

| User describes | Spawn |
|---|---|
| New feature (all layers) | domain + data + pres + app |
| Update presentation only | pres + app |
| Update data + domain | domain + data + app |
| UI layout / visual / icon / ordering | pres |
| New or changed fields on existing data | domain + data |
| New screen or flow | domain + data + pres + app |
| Navigation or routing change | pres + app |
| Business rule / logic change | domain |
| API contract change | data |

Rules:
- New feature → spawn all four (domain, data, pres, app)
- Update presentation only → spawn pres + app
- Update data + domain → spawn domain + data + app
- Use judgment for partial update cases
