---
name: developer-backend
description: Build the Domain and Data layers for a feature — entities, repository interfaces, use cases, mappers, datasources, and repository implementations. Calls skills directly in layer order.
user-invocable: true
disable-model-invocation: true
---

Spawn the `developer-backend-worker` agent with:

```
feature: $FEATURE
platform: $PLATFORM
operations: $OPERATIONS
backend-type: $BACKEND_TYPE
```

Prompt the user for any missing values before spawning:
- `feature` — feature name (e.g. `PayslipDetail`)
- `platform` — `web`, `ios`, or `flutter`
- `operations` — comma-separated subset of: get-list, get-single, create, update, delete
- `backend-type` — `remote-api` (default) or `local-db`
