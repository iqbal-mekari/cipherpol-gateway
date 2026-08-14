---
name: developer-debug-report-ts
description: Investigate a TypeScript/mobile issue report end-to-end — classify the issue, gate on available data, fetch Firebase Crashlytics events and Loki logs, trace the root cause through Clean Architecture layers, propose solutions, and implement the chosen fix.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read
---

## Step 0 — Prerequisites and Run Setup

**Verify MCPs are reachable** before touching any user input:

1. Check Firebase MCP: confirm `mcp__firebase__crashlytics_get_report` is available. If not — stop immediately:
   > Firebase MCP is not configured. Enable the `firebase` MCP with the `crashlytics` feature group and re-run.

2. Check Loki MCP: confirm `mcp__loki-mcp__loki_query` is available. If not — stop immediately:
   > Loki MCP is not configured. Enable the `loki-mcp` MCP server and re-run.

**Derive PROJECT_PATH:**

```bash
echo "$PWD"
```

Store the output as `PROJECT_PATH` — this is the downstream repo the user opened Claude in.

**Create run directory and report file:**

Report structure and section contracts: `$CLAUDE_PLUGIN_ROOT/reference/developer/debug-report-ts-format.md`.

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SLUG="ts-report"
RUN_DIR="$PWD/.claude/agentic-state/runs/developer/debug-report-ts/${TIMESTAMP}-${SLUG}"
REPORT_FILE="${RUN_DIR}/report.md"
mkdir -p "$RUN_DIR"
cat > "$REPORT_FILE" << 'EOF'
# TS Issue Report
Started: PLACEHOLDER
EOF
echo "RUN_DIR=$RUN_DIR"
echo "REPORT_FILE=$REPORT_FILE"
```

Store `RUN_DIR` and `REPORT_FILE` from the output.

---

## Step 1 — Intake

> If confidence in any answer is below 95%, ask a targeted follow-up before continuing.

Use `AskUserQuestion` — one question at a time — to collect all of the following.

**Required — ask if not already visible in context:**

1. > "What is the issue? Paste the bug report, error message, or user complaint."

2. > "Which repo is this for?"
   Options: `mobile-talenta` (Flutter), `talenta-mobile-android` (Android), `talenta-ios` (iOS)
   (Repo → platform map: see `$CLAUDE_PLUGIN_ROOT/reference/developer/debug-report-ts-config.md`)

3. > "What is the screen or feature area where this happens? (e.g. Attendance Clock-In, Leave Request, Payslip — give your best guess)"

**Optional — collect in one follow-up question covering all fields at once:**

4. > "Provide any of these you have (leave blank for any you don't):
   > - Date range (e.g. 2026-06-01 to 2026-06-25)
   > - OS version
   > - Talenta app version
   > - User ID
   > - User email
   > - Company ID"

Write `## Issue Spec` to the report file. Use `Bash` to append:

```bash
cat >> "$REPORT_FILE" << 'SECTION'
## Issue Spec
- Report: <issue_description>
- Repo: <repo>
- Screen hint: <screen>
- Date range: <date_range or "not provided">
- OS version: <os_version or "not provided">
- Talenta version: <talenta_version or "not provided">
- User ID: <user_id or "not provided">
- User email: <user_email or "not provided">
- Company ID: <company_id or "not provided">
SECTION
```

---

## Step 2 — Classify

Spawn `developer-debug-ts-classify-worker` with:

```
mode: classify
issue_spec: <full issue spec from Step 1>
project_path: <PROJECT_PATH>
screen_hint: <screen name from Step 1>
```

Extract `Classification:` block from the worker output. It will be one of: `api`, `anr`, `crash`, `other`.

Append `## Classification` to the report:

```bash
cat >> "$REPORT_FILE" << 'SECTION'
## Classification
<worker output verbatim>
SECTION
```

**DATA GUARD — check before proceeding to Steps 3–4:**

If the user provided NO data properties at all (no OS version, Talenta version, user ID, user email, company ID, and no date range) → skip Steps 3 and 4, jump directly to Step 5.

---

## Step 3 — Firebase Findings

**Applies to all classification types: `api`, `anr`, `crash`, `other`.**

**Collect required filter fields** (if not already provided in Step 1):

Use `AskUserQuestion` for each missing item:
- If `os_version` is missing → ask: "What OS version did the affected user have? (required for Firebase filter)"
- If `talenta_version` is missing → ask: "What Talenta app version? (required for Firebase filter)"
- If `date_range` is missing → ask: "What date range should I search in Firebase? (max 90-day window, format: YYYY-MM-DD to YYYY-MM-DD)"

**Determine `app_id`** from `repo` selection (canonical values in `$CLAUDE_PLUGIN_ROOT/reference/developer/debug-report-ts-config.md` § Firebase):
- `mobile-talenta` or `talenta-mobile-android` → `android:co.talenta`
- `talenta-ios` → `ios:co.talenta.ios`

Spawn `developer-debug-ts-firebase-worker` with:

```
app_id: <android:co.talenta or ios:co.talenta.ios>
project_id: talenta-production
classification: <classification>
os_version: <os_version>
talenta_version: <talenta_version>
date_range: <date_range>
user_id: <user_id or "not provided">
user_email: <user_email or "not provided">
company_id: <company_id or "not provided">
implicated_area: <implicated_area from classify worker>
```

Append `## Firebase Findings` to the report file with the worker output.

---

## Step 4 — Loki Findings

**Only for classification `api` or `other`. Skip for `anr` and `crash`.**

### Check 1 — Remote config gate

Use `AskUserQuestion`:

> "Is the remote config flag `mekari_log_cache_retention_validator` already ENABLED for this specific user AND has the user reopened the app after the flag was enabled?"
> (Flag name canonical source: `$CLAUDE_PLUGIN_ROOT/reference/developer/debug-report-ts-config.md` § Loki / Grafana)
>
> Options:
> - Yes — both conditions are met, proceed with Loki query
> - No — I need to enable the flag first

If `No` → instruct the user:
> Enable `mekari_log_cache_retention_validator` for this user in the remote config dashboard, then ask the user to force-close and reopen the Talenta app. Once they've reopened the app, re-run `/developer-debug-report-ts` to continue.

Then **STOP** — do not proceed until the gate is satisfied.

### Check 2 — Collect Loki inputs

Use `AskUserQuestion` to collect — one at a time:

1. > "What is the encrypted user identifier for this user? (the `+_..._ENC` value from the Talenta Flutter encrypter — typically the encrypted email)"

2. > "When was the `mekari_log_cache_retention_validator` flag toggled ON for this user? (This is the Loki query start date — format: YYYY-MM-DD)"

3. > "What is the activity time range to focus on? (when the issue actually happened on the user's device, WIB — e.g. 2026-06-10 14:00 to 15:30)"

4. > "Is this a live tracking or geolocation issue?"
   Options: Yes, No

Store `encrypted_identifier`, `flag_toggle_date`, `activity_time_range`, `is_geolocation`.

### Loki query execution

Spawn `developer-debug-ts-loki-query-worker` with:

```
encrypted_identifier: <encrypted_identifier>
flag_toggle_date: <flag_toggle_date>
activity_time_range: <activity_time_range>
```

If `is_geolocation` is Yes, also spawn `developer-debug-ts-loki-live-tracking-worker` in parallel with:

```
user_id: <user_id>
time_range: <activity_time_range>
```

Wait for all loki workers to complete. Write raw output to disk:

```bash
cat > "$RUN_DIR/loki-raw.json" << 'RAW'
<loki query worker output verbatim>
RAW
```

### Log analysis

Spawn `developer-debug-ts-log-analyzer-worker` with:

```
PROJECT_PATH: <PROJECT_PATH>
RAW_LOG_DATA_PATH: <RUN_DIR>/loki-raw.json
```

Append `## Loki Findings` to the report with the log analyzer output.

---

## Step 5 — Root Cause Analysis

Spawn `developer-debug-ts-classify-worker` with:

```
mode: analyze-root-cause
classification: <classification block from Step 2>
firebase_summary: <summary extracted from ## Firebase Findings, or "skipped — no data properties provided">
loki_summary: <summary extracted from ## Loki Findings, or "skipped — classification is anr/crash" or "skipped — no data properties provided">
implicated_area: <implicated_area from Step 2>
project_path: <PROJECT_PATH>
```

Append `## Code Analysis`, `## Root Cause`, and `## Proposed Solutions` to the report with the worker output.

---

## Step 6 — Choose a Solution

Use `AskUserQuestion`:

> "Here are the proposed solutions from the analysis:
>
> <list the solutions from ## Proposed Solutions with their tradeoffs>
>
> Which would you like to implement?"
>
> Options:
> - Solution 1: <title>
> - Solution 2: <title>
> - Solution 3: <title> (if present)
> - None — just give me the report

Append `## Chosen Solution` to the report.

If the user chose "None" → jump to END.

---

## Step 7 — Implement

Spawn `developer-debug-ts-fix-worker` with:

```
fix_brief: <chosen solution title + description + implicated file paths from ## Proposed Solutions>
project_path: <PROJECT_PATH>
```

**If the worker returns an `Instrumentation recommended:` block** (Step 2 of the fix-worker), the fix has not yet been applied. Do the following before re-invoking:

1. Spawn `developer-debug-log-worker` with:
   ```
   MODE: add
   INSTRUMENTATION_BRIEF: <the Files / Methods / What to log values from the recommendation block>
   PLATFORM: <Platform from the recommendation block>
   ```
2. Wait for `developer-debug-log-worker` to complete.
3. Re-spawn `developer-debug-ts-fix-worker` with the same `fix_brief` and `project_path` (without the `instrumentation: true` flag so Step 2 is skipped this time).

Append `## Implementation` to the report with the final worker output.

---

## END — Surface Report

```bash
echo "Report written to: $REPORT_FILE"
```

> Investigation complete. Full report at: `<REPORT_FILE>`
> Run directory: `<RUN_DIR>`

---

## Confidence Rule

Whenever you are less than 95% confident about any value, classification, or routing decision, use `AskUserQuestion` before proceeding. Never guess on behalf of the user — incorrect assumptions silently corrupt the investigation.
