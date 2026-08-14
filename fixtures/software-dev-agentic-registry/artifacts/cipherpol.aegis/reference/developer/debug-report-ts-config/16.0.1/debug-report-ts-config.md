# Developer Debug Report-TS Config

> Author: Aflah Taqiu Sondha · 2026-06-25
> Related: developer-debug-report-ts/SKILL.md, developer-debug-ts-firebase-worker.md, developer-debug-ts-loki-live-tracking-worker.md

Talenta-specific environment constants for the `developer-debug-report-ts` flow. All agents and skills load values from this single source of truth — they do NOT inline these values directly.

---

## Firebase

| Key | Value |
|---|---|
| Project ID | `talenta-production` |
| Android app ID | `android:co.talenta` |
| iOS app ID | `ios:co.talenta.ios` |

### Crashlytics Dashboards

| Platform | URL |
|---|---|
| Android | https://console.firebase.google.com/u/0/project/talenta-production/crashlytics/app/android:co.talenta |
| iOS | https://console.firebase.google.com/u/0/project/talenta-production/crashlytics/app/ios:co.talenta.ios/ |

---

## Repo → Platform Map

| Repo name | Platform |
|---|---|
| `mobile-talenta` | Flutter |
| `talenta-mobile-android` | Android |
| `talenta-ios` | iOS |

---

## Loki / Grafana

| Key | Value |
|---|---|
| Grafana datasource URL | `https://grafana.mekari.io/api/datasources/proxy/uid/bb793898-48b7-4961-92f5-81d29bf1d114` |
| Remote-config gate flag | `mekari_log_cache_retention_validator` |

---

## Usage Note

Reference this file from agents and skills via:

```
$CLAUDE_PLUGIN_ROOT/reference/developer/debug-report-ts-config.md
```

Do not copy or re-inline these values — point to this document.
