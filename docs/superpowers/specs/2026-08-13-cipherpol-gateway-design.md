# Cipherpol Gateway Design

**Date:** 2026-08-13  
**Status:** Approved architecture  
**Initial client:** Claude Code  
**Primary audience:** Mekari mobile engineers  

## 1. Purpose

Cipherpol is Mekari Mobile's centralized AI tooling platform. It distributes approved agents, skills, playbooks, hooks, and MCP tool bundles to Claude Code while centralizing identity, authorization, credentials, package governance, observability, and revocation.

The platform evolves the existing `/Users/iqbal/projects/software-dev-agentic` toolkit rather than replacing it. That repository remains the authoring and compilation layer for the existing agent and skill corpus. Cipherpol adds immutable package distribution, explicit version resolution, seamless but intentional updates, machine-enforceable playbooks, and a governed MCP gateway.

The first-release success criterion is:

> A mobile engineer can install Cipherpol, authenticate, configure an existing registered repository, and complete a governed mobile-development workflow in less than 15 minutes.

## 2. Scope

### 2.1 In scope

- Internal Mekari mobile engineering workflows for Flutter, Android, iOS, QA, release, and mobile platform teams.
- Claude Code as the only initial agent runtime.
- A thin `cipherpol` Claude plugin for setup, update, diagnosis, and rollback.
- Generated, immutable `cipherpol-runtime` plugin generations containing selected agents, skills, hooks, playbooks, references, and one Cipherpol MCP binding.
- A centralized control plane for package registry, policy, identity, release channels, ownership, exceptions, and operational reporting.
- A centralized MCP data plane for authentication, authorization, tool filtering, credential brokerage, routing, rate limiting, audit, and revocation.
- Universal task classification with specialized capability packs and a general mobile-engineering fallback.
- Tiered playbook enforcement for Flutter Clean Architecture, Mobile Commons, Mekari Pixel, Git/TDD, and repository-specific rules.
- Federated publishing by Android, iOS, Flutter, QA, and platform teams with owner review and automated admission checks.
- Portable deployment as containerized components; the initial infrastructure target is intentionally not coupled to a specific cluster or cloud.
- Full functional parity for every capability currently shipped by the `software-dev-agentic` marketplace, including its Web/Next.js and generic cp9 capabilities. Mobile remains the initial consumer and pilot scope; non-mobile parity remains available through separately scoped catalog bundles.

### 2.2 Explicit non-goals for the first release

- Hosting the model or agent reasoning centrally. Claude Code executes agents on the engineer's workstation.
- Supporting Codex, Cursor, Copilot, or Gemini adapters.
- Preventing every direct local file edit through the MCP gateway. CI and Git controls are authoritative for repository compliance.
- Automatically activating runtime updates at session start.
- Rewriting the existing software-dev-agentic agent and skill corpus before registry admission demonstrates a concrete need.
- Retaining full MCP request or response payloads by default.
- Providing customer-facing or in-product Mekari agents. Internal and external trust planes must remain separate.

## 3. Design principles

1. **One consumer entry point.** Engineers install one bootstrap plugin, authenticate once, and use one MCP endpoint.
2. **Task-oriented composition.** Consumers ask for work; they do not manually choose every agent, skill, or MCP server.
3. **Capability and method are separate.** Capability packs define what a workflow needs. Playbooks define how the work must be performed and validated.
4. **Enforce at the correct boundary.** Prompts guide, hooks verify locally, CI governs repository compliance, and the MCP gateway governs external actions.
5. **Explicit activation.** Session startup may announce compatible updates, but only an intentional consumer command may download, stage, or activate a generation.
6. **Immutable resolution.** Every active runtime is identified by exact versions and content digests.
7. **Safe recovery.** Generation activation is transactional and preserves the previous healthy generation.
8. **Federated ownership with central contracts.** Teams own content; the platform owns schemas, admission gates, runtime compatibility, and security controls.
9. **Metadata-first observability.** Audit identity, authorization, timing, sizes, status, and cost without retaining sensitive payloads by default.
10. **Modular monolith first.** Keep logical control/data boundaries, but split physical services only when measured scale, availability, or trust boundaries require it.

## 4. User experience

### 4.1 Initial bootstrap installation
Mekari-managed workstations preconfigure the authenticated internal Claude marketplace under the stable alias `cipherpol`. The consumer installs the thin plugin:

```text
/plugin install cipherpol@cipherpol
/reload-plugins
```

Marketplace source configuration is a managed-device/platform deployment responsibility and is not stored in consumer repository manifests.

### 4.2 Repository setup

From Claude Code at the repository root, the consumer runs:

```text
/cipherpol-setup
```

The command delegates to a portable script shipped under `${CLAUDE_PLUGIN_ROOT}`. It:

1. Authenticates the engineer through Mekari SSO using a browser or device authorization flow.
2. Detects repository identity and platform from registered markers.
3. Reads the committed `cipherpol.yaml`.
4. Resolves compatible capability packs, playbooks, hooks, agents, skills, and MCP bindings.
5. Presents the complete proposed generation and policy changes.
6. Requires explicit confirmation.
7. Downloads immutable artifacts from the registry.
8. Verifies signatures, digests, schemas, namespaces, and compatibility ranges.
9. Stages a new runtime generation outside the active path.
10. Runs pre-activation health checks.
11. Atomically selects the new generation.
12. Writes `cipherpol.lock`.
13. Requests `/reload-plugins` so Claude Code discovers the selected generation.
14. Runs post-reload checks on the next Cipherpol command or session hook.

### 4.3 Daily use

Consumers ask naturally, for example:

- "Implement this Jira ticket for Flutter."
- "Debug this Crashlytics issue."
- "Generate Patrol tests for this Figma flow."
- "Check whether this release is ready."
- "Refactor this module to our Clean Architecture playbook."

The task router resolves repository context, intent, risk, capability packs, applicable playbooks, specialist agents, approved MCP tools, and required evidence. Consumers may explicitly invoke specialists for expert use or diagnosis, but routine work must not require that knowledge.

Unknown tasks route to the general mobile-engineering capability pack. The router must not invent or claim a nonexistent specialist.

### 4.4 Explicit updates

Session startup may perform a cheap metadata check and display that a compatible release exists. It must not mutate the active installation.

```text
/cipherpol-update --check
```

Displays:

- active and available generations;
- agent and skill changes;
- playbook and enforcement-level changes;
- MCP additions, removals, or permission changes;
- compatibility results;
- migrations;
- breaking-risk classification.

```text
/cipherpol-update
```

Resolves, previews, asks for confirmation, downloads, verifies, stages, health-checks, and selects the new generation. The consumer then runs `/reload-plugins`.

```text
/cipherpol-rollback
```

Selects the previous healthy generation when rollback is permitted. The consumer reloads plugins afterward.

### 4.5 Diagnosis and recovery

```text
/cipherpol-doctor
```

Checks:

- bootstrap plugin version and registry API compatibility;
- SSO session and identity;
- project registration and manifest validity;
- active and desired generation;
- artifact digests and signatures;
- Claude Code feature compatibility;
- plugin discovery and hook loading;
- policy version;
- MCP gateway reachability and required OAuth grants.

If the thin bootstrap plugin itself cannot load, routine self-repair is impossible. The documented recovery path is to reinstall the bootstrap from the internal marketplace or run a separately distributed signed recovery installer. Bootstrap releases must therefore be rare, backward-compatible across multiple registry API versions, and operationally independent from runtime releases.

## 5. Consumer configuration contracts

### 5.1 `cipherpol.yaml`

`cipherpol.yaml` is the committed desired-state manifest reviewed by the repository team. It contains:

```yaml
schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms:
  - flutter
channel: stable
capabilityPacks:
  - feature-delivery
  - production-debugging
  - ui-automation
  - release-readiness
  - general-mobile-engineering
playbooks:
  - flutter-clean-architecture
  - mobile-commons
  - mekari-pixel
  - git-tdd
policyProfile: standard
owners:
  - mobile-platform
```

Repository overlays and exceptions are references to registered policy objects, not unvalidated executable snippets.

### 5.2 `cipherpol.lock`

`cipherpol.lock` records resolved state:

- lock schema version;
- generation ID;
- release channel;
- exact package versions and immutable digests;
- Claude Code compatibility range and required capabilities;
- playbook, validator, and hook versions;
- MCP bundle version;
- activation timestamp and actor;
- last successful health-check result;
- previous healthy generation ID.

The lock is generated by Cipherpol. Teams choose whether to commit it based on repository policy. The control plane always retains an authoritative activation record so local deletion cannot erase the audit trail.

## 6. Core domain model

### 6.1 Package

A namespaced, immutable artifact with:

- stable package ID;
- type: agent, skill, procedure, reference, hook, validator, adapter, or bootstrap;
- semantic version;
- content digest and signature;
- owner;
- source revision;
- dependency graph;
- compatibility constraints;
- security and data classification;
- deprecation and revocation state.

Namespaced IDs replace basename-only flattening and prevent silent agent or skill collisions.

### 6.2 Capability pack

A task-oriented composition defining:

- intents and task classes handled;
- supported platforms and repository types;
- orchestrating agent;
- required and optional skills;
- approved MCP tool bundle;
- required playbooks;
- permissions and data classification;
- required evidence;
- fallback and escalation behavior;
- owner, version, and compatibility constraints.

Initial packs are feature delivery, production debugging, UI automation, release readiness, and general mobile engineering.

### 6.3 Playbook

A versioned engineering contract defining:

- applicability predicates;
- required workflow stages;
- architecture and dependency rules;
- approved and prohibited patterns;
- required evidence;
- rationale and remediation guidance;
- validator implementations;
- enforcement level;
- exception authority and expiry rules;
- owner and version.

One playbook version produces aligned agent guidance, local-hook behavior, and CI validator configuration. The platform must reject publication when these artifacts contradict the declared rule.

### 6.4 MCP server and tool

A registered server carries owner, transport, environments, authentication mode, health state, and discovered tool catalog. Each tool carries a stable namespaced ID, descriptions, input/output schemas, read/write/destructive classification, data classification, rate-limit policy, and approval requirements.

### 6.5 Bundle

A bundle exposes a curated, task-oriented set of tools across one or more MCP servers. Discovery and invocation enforce the same authorization policy. Raw downstream catalogs are never exposed merely because a server is registered.

### 6.6 Generation

A generation is the complete immutable runtime resolution for one project, channel, policy profile, and Claude Code compatibility set. It references exact package and bundle versions and is either staged, healthy, active, superseded, failed, revoked, or rolled back.

## 7. System architecture

### 7.1 Thin `cipherpol` bootstrap plugin

The bootstrap contains:

- `/cipherpol-setup`;
- `/cipherpol-update`;
- `/cipherpol-doctor`;
- `/cipherpol-rollback`;
- portable registry, authentication, verification, staging, activation, and recovery scripts;
- an optional metadata-only update notification hook;
- an optional minimal registry/status MCP binding.

It contains no mobile specialist agents, workflow corpus, project playbooks, or downstream tool catalog. Its responsibility is limited to securely managing runtime generations.

### 7.2 Generated `cipherpol-runtime` plugin

The selected runtime generation contains:

- task router and capability-pack agents;
- selected specialist agents and skills;
- applicable playbook instructions and references;
- local verification hooks;
- one `.mcp.json` binding to the Cipherpol gateway;
- generation metadata for diagnosis and audit.

Runtime content is generated from registry objects. The existing Claude marketplace format remains an adapter, not the source of truth.

### 7.3 Control plane

The control plane is the source of truth for:

- packages, agents, skills, playbooks, validators, hooks, servers, tools, bundles, and generations;
- owners and approval workflows;
- user, team, project, environment, agent, and tool policies;
- release channels and staged rollout;
- compatibility and revocation;
- SSO identities, agent/client registrations, OAuth grants, and credential bindings;
- activation, usage, compliance, quality, and cost metadata;
- portal and API for federated self-service.

The initial implementation is a modular monolith with a relational database and background workers. Its modules expose explicit internal interfaces so package admission, identity, policy, generation resolution, and operations can split later without changing consumer contracts.

### 7.4 MCP data plane

The data plane:

1. Authenticates the user, client, and agent context.
2. Resolves project, environment, bundle, and policy.
3. Filters `tools/list` to approved tools.
4. Reauthorizes every `tools/call` independently of discovery.
5. Obtains the correct credential mode.
6. Applies rate limits and approval requirements.
7. Routes to the downstream MCP server.
8. Propagates trace context.
9. Redacts structured error metadata.
10. Emits an attributable usage event.

Logical control/data separation is mandatory. Physical separation occurs when internet exposure, availability objectives, load, or blast-radius analysis requires it.

## 8. Identity, authorization, and credentials

Every governed call records two principals where available: the human user and the agent/client acting for that user. Policy can evaluate user, team, project, repository, environment, agent, capability pack, bundle, server, tool, action class, and requested credential mode.

Supported credential modes are:

1. **Internal service identity:** forward verified Mekari caller context.
2. **Gateway-held token:** inject a centrally managed vendor or service token.
3. **Per-user OAuth:** store encrypted grants and inject or refresh user-scoped access.
4. **Service principal:** mint or broker short-lived non-personal credentials for approved automation.

Agents never receive raw vendor keys, OAuth refresh tokens, or shared service credentials.

A missing per-user OAuth grant is a normal recoverable state. The gateway returns an elicitation or structured authorization-required response with a connection URL. After authorization, supported clients resume the original tool call; otherwise the agent retries with preserved task context.

Emergency revocation may deny a package, credential binding, server, tool, bundle, or generation immediately. Revocation may block unsafe gateway calls before a consumer updates, but it must not silently rewrite local plugin files.

## 9. Playbook enforcement

Rules use three enforcement levels:

- **Recommend:** agent instructions, examples, and preferred patterns.
- **Verify:** local hooks and PR reporting detect violations and require evidence, but local bypass remains possible.
- **Require:** deterministic CI, Git, or gateway controls block the prohibited outcome.

### 9.1 Example initial policy

| Rule | Initial level | Authoritative boundary |
|---|---|---|
| Load applicable Flutter Clean Architecture guidance | Verify | Claude hook/report |
| Domain cannot import Flutter or Data packages | Require | Static architecture check in CI |
| Use approved Mobile Commons versions | Require | Dependency policy in CI |
| Prefer existing Mobile Commons utility | Verify | Lint/report with remediation |
| Use Mekari Pixel component when an equivalent exists | Require | Custom lint in CI |
| Handle a design-system gap through registered exception | Verify | Hook and PR report |
| Follow test-first workflow | Verify | Hook-generated evidence ledger |
| Relevant behavior tests pass | Require | CI |
| External write tool requires appropriate authorization | Require | MCP gateway |

### 9.2 Git/TDD evidence

Cipherpol can verify observable evidence, not a developer's intent. The Git/TDD playbook may require:

1. a relevant test was introduced or changed;
2. the focused test was observed failing before acceptance of implementation evidence;
3. the focused test subsequently passed;
4. affected existing tests passed;
5. the PR links the evidence ledger.

Git commit order alone is insufficient proof because history can be rewritten. CI enforces the final behavioral contract. Local hooks provide workflow evidence without claiming mathematical proof of authentic TDD practice.

### 9.3 Exceptions

A required-rule exception must include:

- rule ID and version;
- project and scope;
- justification;
- approving owner;
- creation and expiry timestamps;
- compensating control;
- audit reference.

Exceptions expire automatically and cannot silently downgrade unrelated rules.

## 10. Package publication and update lifecycle

### 10.1 Federated publication

Android, iOS, Flutter, QA, and platform teams publish through the control-plane portal/API or repository automation. Admission requires owner review and deterministic checks.

### 10.2 Registry admission

Existing `software-dev-agentic` checks become admission gates:

- `check_procedures()` validates procedure include edges, executed-by declarations, and transitive tool grants.
- `check_agent_context()` validates project-root scoping for searching agents.
- deterministic builds reject source/generated drift.

New admission gates add:

- schema and namespace validation;
- duplicate stable-ID rejection;
- dependency-cycle and compatibility checks;
- secret and unsafe-instruction scanning;
- hook and validator tests;
- source-to-artifact provenance;
- immutable digest generation and signing;
- Claude Code compatibility tests;
- install, update, rollback, discovery, and MCP health scenarios.

### 10.3 Release channels

- **Canary:** opted-in maintainers receive early compatible generations.
- **Stable:** normal repositories receive releases promoted after canary gates pass.
- **Pinned:** high-risk or regulated workflows move only through an explicit manifest change.

Promotion changes registry eligibility, not the active consumer generation. Consumers still activate explicitly.

### 10.4 Transactional activation

The bootstrap resolves, downloads, verifies, stages, checks, and activates a generation. The active pointer changes only after pre-activation checks pass. The previous healthy generation remains available. A post-reload failure marks the new generation unhealthy and instructs the consumer to roll back; automatic file mutation after reload is prohibited without another explicit consumer action.

## 11. Migration from software-dev-agentic

### 11.1 Preserve

- authored agents, skills, procedures, and references under existing `lib/**` trees;
- independently versioned modules;
- deterministic source/generated builds;
- the cp1 remote knowledge separation;
- `cipherpol.json` platform/project concepts and detection markers;
- procedure/tool graph validation;
- committed release history and provenance.

### 11.2 Wrap

- Generate Claude-compatible marketplace and plugin adapters from registry objects.
- Put `scripts/install-plugin.sh` behavior behind `/cipherpol-setup` with SSO, preflight, preview, staging, health verification, and rollback.
- Register cp1 `.mcp.json` as a versioned gateway endpoint and credential binding.
- Run existing build checks during package admission.
- Convert high-value Markdown playbook gates into aligned instructions, hooks, and CI validators.

### 11.3 Replace

- Mutable Git marketplace resolution as the runtime source of truth.
- Implicit highest-cached-version selection.
- Basename-flattened package identity and silent collisions.
- Unknown-project fallback to an arbitrary cp1 slug.
- Direct, non-transactional mutation of Claude settings.
- Undeclared Claude Code compatibility.
- Markdown prose as the sole mechanism for enforceable policy.

### 11.4 Migration sequence

1. Define registry schemas and namespaced IDs around current artifacts.
2. Import current packages without rewriting their behavior.
3. Run existing checks as admission checks and produce signed immutable artifacts.
4. Ship the thin `cipherpol` bootstrap alongside the current marketplace installation.
5. Generate equivalent `cipherpol-runtime` content and prove behavior parity.
6. Pilot explicit setup/update/rollback with canary maintainers.
7. Route cp1 and selected low-risk MCP tools through the gateway.
8. Add playbook instructions, then verification hooks, then deterministic CI requirements.
9. Promote stable repositories after onboarding, compatibility, and recovery objectives pass.
10. Retire direct runtime resolution from the mutable marketplace while retaining the bootstrap marketplace.

### 11.5 Functional parity contract

The shipping marketplace is the parity source of truth: `cipherpol-aegis@16.0.1`, `cipherpol-9@13.14.0`, and `cipherpol-1@0.2.0`. Documentation-only proposals, changelog history, `dist` duplicates, `cipherpol-0`, and retired modules are not capabilities unless separately approved.

The baseline contains:

- 34 user-facing orchestrator entries;
- 67 shipped skills, comprising 34 orchestrators and 33 agent-only procedures;
- 47 shipped agents;
- 36 shipped Markdown references plus the packaged platform/project taxonomy;
- the cp1 MCP binding and all 17 currently registered cp1 MCP tools;
- current setup, context resolution, disk handoff, knowledge retrieval, approval, and packaging behavior;
- Flutter, iOS, Android, Web/Next.js, generic cp9, QA, developer, aegis, and cp1 scopes represented by the shipping artifacts.

Cipherpol must maintain a versioned parity manifest generated from authored sources. Each entry records a namespaced stable ID, source revision and path, artifact type, user trigger, composition edges, required procedures/references/tools/MCP capabilities, platform/project applicability, permissions, and shipped status. Proposed IDs follow:

```text
cipherpol.<module>.skill.<frontmatter-name>
cipherpol.<module>.agent.<frontmatter-name>
cipherpol.<module>.procedure.<frontmatter-name>
cipherpol.<module>.reference.<relative-stem>
cipherpol.cp1.mcp.<tool-name>
```

Parity is semantic rather than filename-only. Admission and migration tests must verify:

1. the exact user-facing catalog and the distinction between orchestrators, internal procedures, and workers;
2. orchestrator-to-agent-to-procedure composition, ordering, parallel fan-out, approval loops, retries, stops, and disk handoffs;
3. declared tool permissions and denial of undeclared writes;
4. the six-rung working-context resolution, project-root scoping, taxonomy mappings, and session pins;
5. cp1 query coordinates, project-over-platform knowledge precedence, authentication, fallbacks, destructive confirmation, and all 17 tool schemas;
6. setup dry-run/apply behavior, idempotency, status/doctor read-only behavior, and the fact that current shipped plugins contain no hooks;
7. artifact reachability, reference rewrites, executable auxiliaries, and collision failure;
8. current platform restrictions, including Flutter-only Patrol/mock automation and Talenta-only debug-report workflows;
9. behavioral output contracts such as plans, context/state files, progress trackers, tickets, RFCs, system designs, Figma UI stacks, QA CSV/Gherkin, and mock honesty gates.

Every baseline capability must end migration in exactly one state:

- **Equivalent:** available through Cipherpol with parity evidence;
- **Equivalent with normalized dependency:** unchanged workflow semantics behind a registered alias for inconsistent MCP names or environment bindings;
- **Explicitly unsupported:** blocked from stable promotion by a documented product decision approved after this specification.

Omission, silent narrowing, and substituting a generic fallback do not satisfy parity. Stable promotion is blocked until every baseline entry has a state and evidence.

The initial parity decision is to include all built cp1 skills and `cp1-codebase-explorer`, even where README text is stale. Existing empty tool allowlists must be replaced by explicit least-privilege contracts before admission. Inconsistent Figma, Atlassian/MMPA, cp1-dev, Firebase, Loki, Patrol, Pokayoke, GitHub CLI, and WebFetch dependencies must be represented by normalized capability IDs and environment-specific bindings rather than prompt-specific raw tool names.

## 12. Data flow

### 12.1 Task execution

```text
Engineer request
  → Claude Code task router
  → repository/platform/risk classification
  → capability-pack and playbook resolution
  → selected local agents and skills
  → curated tools/list from Cipherpol MCP gateway
  → per-call authorization and credential brokerage
  → downstream MCP server
  → redacted result to Claude Code
  → attributable usage and policy event
  → local and CI evidence attached to the workflow
```

### 12.2 Runtime update

```text
Metadata notice
  → /cipherpol-update --check
  → explicit /cipherpol-update
  → authenticate and resolve
  → preview and confirm
  → fetch immutable artifacts
  → verify signature/digest/compatibility
  → stage new generation
  → pre-activation health check
  → atomically select generation
  → /reload-plugins
  → post-reload health check
  → retain previous healthy generation
```

## 13. Failure handling

- **Registry unavailable:** keep the active healthy generation; daily local workflows continue except registry-dependent actions.
- **Authentication expired:** request SSO renewal; never fall back to anonymous or shared credentials.
- **Artifact verification failure:** reject activation and retain the active generation.
- **Compatibility mismatch:** resolve another eligible generation or report the exact unsupported Claude capability/version.
- **Unknown project:** stop setup and require registration or an explicitly marked unscoped mode with no project knowledge or write tools.
- **MCP server unavailable:** return a structured upstream error with server owner and retry guidance; do not fabricate fallback results.
- **Missing OAuth grant:** return a recoverable authorization-required state.
- **Policy denial:** return rule, decision basis, owner, remediation, and exception path without leaking sensitive policy internals.
- **Post-reload health failure:** mark the generation unhealthy and direct the consumer to `/cipherpol-rollback`.
- **Bootstrap failure:** use marketplace reinstall or the signed recovery installer.
- **Audit pipeline unavailable:** buffer bounded metadata locally in the gateway data plane or fail closed for write/destructive tools according to policy; read-only policy decides explicitly whether degraded operation is permitted.

## 14. Observability, privacy, and cost

Each governed MCP call emits:

- request, trace, generation, agent, capability-pack, bundle, server, tool, and owner IDs;
- user, team, project, environment, and client identities;
- authorization and rate-limit decision;
- credential mode without secret material;
- status, error source, and latency breakdown;
- request and response byte sizes;
- downstream-reported cost metadata;
- redaction result and policy version.

Request and response bodies are not retained by default. Debug sampling requires explicit policy, narrow scope, redaction, retention limits, and owner approval.

Operational dashboards cover adoption, onboarding duration, update success and rollback, runtime versions, policy violations, exceptions, tool usage, failures, latency, OAuth outcomes, and cost attribution.

Cost controls include task-scoped catalogs, response-size limits, rate limits, metadata-only update checks, bounded audit events, retention tiers, and modular-monolith deployment until measured load justifies separation.

## 15. Security boundaries

- Cipherpol-governed tools must be reachable only through authenticated gateway paths where infrastructure permits.
- Advisory governance allows direct non-catalog MCP use; such calls are outside Cipherpol's attribution, secret, and policy guarantees.
- Bootstrap and runtime artifacts are immutable and signed.
- Downstream credentials remain in the gateway credential store.
- Tool discovery is authorization-filtered and cannot be treated as authorization for invocation.
- Destructive or high-risk write tools require explicit policy and may require human approval.
- Internal engineering and future customer-facing planes must not share proxy deployments or credentials.
- Package revocation and tool revocation are independent controls.

## 16. Verification strategy

### 16.1 Package and registry contracts

- Reject duplicate IDs, invalid schemas, dependency cycles, unsupported compatibility, invalid signatures, and source/generated drift.
- Prove deterministic artifact output from the same source revision.
- Prove the current agent/skill behavior remains equivalent after registry packaging.

### 16.2 Bootstrap lifecycle

Exercise clean installation, repeated idempotent setup, explicit update preview, declined activation, successful activation, failed verification, failed health check, rollback, expired authentication, unknown project, and bootstrap recovery.

### 16.3 MCP governance

Exercise filtered discovery, invocation reauthorization, read/write differences, user/team/project policies, every credential mode, missing OAuth, revocation, rate limiting, upstream failure, trace propagation, error redaction, and audit degradation behavior.

### 16.4 Playbook enforcement

For each required rule, include a compliant fixture and at least one plausible violation that fails at the authoritative boundary. Verify recommend and verify rules do not falsely claim hard enforcement. Verify exceptions are scoped and expire.

### 16.5 End-to-end pilot journeys

Run feature delivery, production debugging, UI automation, release readiness, and an unknown general mobile task in registered Flutter, Android, and iOS repositories. Measure setup duration, routing correctness, tool selection, policy evidence, recovery, and consumer intervention.

## 17. Acceptance criteria

The first release is acceptable when:

1. A new consumer completes bootstrap installation, SSO, repository setup, reload, and one governed workflow in under 15 minutes at the 90th percentile of pilot runs.
2. Session startup never activates a new runtime generation.
3. `/cipherpol-update` requires explicit invocation and confirmation unless the consumer deliberately supplies a non-interactive confirmation flag.
4. Failed verification or pre-activation health checks leave the prior healthy generation active.
5. Consumers configure one Cipherpol MCP endpoint and never receive raw downstream credentials.
6. Unknown tasks route to the general mobile-engineering pack without fabricating specialists.
7. Registered tool discovery and invocation enforce the same effective authorization policy.
8. Every governed tool call is attributable to user, client/agent, project, generation, server, tool, policy decision, and outcome.
9. Required Clean Architecture, dependency-version, Mekari Pixel, behavioral-test, and external-write rules block at CI/Git or gateway boundaries.
10. A generated parity manifest accounts for all 34 user-facing entries, 67 shipped skills, 47 shipped agents, 36 shipped Markdown references, the packaged taxonomy, and all 17 cp1 MCP tools from the current software-dev-agentic marketplace.
11. Every parity-manifest entry has semantic evidence for invocation, composition, permissions, context, dependencies, packaging, and behavioral outputs; no entry is silently omitted, narrowed, or replaced by a generic fallback.
12. The current software-dev-agentic corpus can be imported, built, admitted, resolved, installed, updated, and rolled back without basename collisions or behavior-changing rewrites.
13. The bootstrap can diagnose an unhealthy runtime and restore a prior healthy generation.
14. Package, credential, tool, and generation revocations take effect independently and are visible to affected consumers.

## 18. Decisions retained for implementation planning

The implementation plan must preserve these approved decisions:

- Full control plane and MCP data plane, not a catalog-only prototype.
- Claude Code-first.
- Thin `cipherpol` bootstrap plugin plus generated `cipherpol-runtime`.
- Existing software-dev-agentic repository as authoring/compiler source.
- Explicit update activation.
- Federated publishing with review.
- Tiered recommend/verify/require playbook enforcement.
- Portable container deployment and modular-monolith implementation first.
- Fast onboarding as the primary 90-day outcome.
- Full functional parity with every capability shipped by the current software-dev-agentic marketplace; mobile remains the first pilot, not the boundary of the catalog.
