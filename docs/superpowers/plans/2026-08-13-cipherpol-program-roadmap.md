# Cipherpol Program Roadmap

> **For agentic workers:** Each stage requires its own approved implementation plan. Do not combine stages into one change set.

**Goal:** Deliver the approved Cipherpol Gateway architecture through independently testable vertical stages.

**Architecture:** Preserve `software-dev-agentic` as the content authoring/compiler source and make complete semantic parity a stable-promotion gate. Build stable registry contracts first, then admission and parity inventory, control-plane services, consumer distribution, governed MCP access, and repository enforcement. Each stage keeps prior contracts and ends with an executable acceptance scenario.

**Tech Stack:** TypeScript, Node.js 20+, pnpm workspaces, JSON Schema-compatible runtime validation, PostgreSQL for the control plane, OCI-compatible containers, Claude Code plugins, MCP Streamable HTTP, OpenTelemetry.

---

## Stage 1 — Contract foundation and local generation resolver

Define namespaced registry objects, `cipherpol.yaml`, `cipherpol.lock`, compatibility rules, deterministic generation resolution, runtime assembly, and a thin local Claude plugin adapter. Prove the complete flow against a filesystem registry fixture without networking or authentication.

Detailed plan: `docs/superpowers/plans/2026-08-13-cipherpol-contract-foundation.md`

## Stage 2 — Artifact admission and software-dev-agentic import

Build deterministic package admission, content hashing, signatures, provenance, namespace collision checks, dependency graph validation, compatibility gates, and an importer for current `software-dev-agentic` authored artifacts. Generate the authoritative parity manifest covering all 34 user-facing entries, 67 shipped skills, 47 agents, 36 Markdown references, the taxonomy, and 17 cp1 MCP tools. Preserve `check_procedures()` and `check_agent_context()` as admission gates, normalize external tool dependencies to stable capability IDs, and prove invocation, composition, permissions, context, packaging, knowledge, and output-contract parity without behavior-changing rewrites.

## Stage 3 — Control plane and registry API

Persist registry objects and generations in PostgreSQL. Add SSO-authenticated package publication, review, release channels, policy profiles, project registration, explicit generation resolution, revocation, activation records, and operational APIs. Keep the first deployment a modular monolith with background workers.

## Stage 4 — Thin Cipherpol plugin lifecycle

Ship the stable `cipherpol` bootstrap plugin with `/cipherpol-setup`, `/cipherpol-update`, `/cipherpol-doctor`, and `/cipherpol-rollback`. Connect it to the control plane, support browser/device SSO, immutable download and verification, staged activation, local managed marketplace generation, explicit confirmation, reload guidance, post-reload health checks, and standalone recovery installation.

## Stage 5 — Governed MCP data plane

Expose one Cipherpol MCP endpoint. Implement authenticated and filtered discovery, per-call authorization, gateway-held tokens, per-user OAuth, service principals, rate limits, approval gates, routing, trace propagation, redacted errors, metadata-only audit events, and independent tool/credential/package revocation.

## Stage 6 — Playbook compiler and enforcement

Model recommend/verify/require rules and compile each playbook version into aligned agent instructions, Claude hooks, CI validators, and gateway policy. Implement Flutter Clean Architecture, Mobile Commons, Mekari Pixel, Git/TDD evidence, exception expiry, and compliance reports. CI and Git remain authoritative for source compliance.

## Stage 7 — Migration and pilot rollout

Generate `cipherpol-runtime` from the complete imported software-dev-agentic corpus. Block stable promotion until every parity entry is equivalent, equivalent behind a normalized dependency, or covered by an explicitly approved unsupported decision; omission and generic fallback do not qualify. Pilot mobile canary repositories across Flutter, Android, and iOS while separately exercising shipped Web/Next.js, generic cp9, aegis, developer, QA, and cp1 catalog capabilities. Measure 90th-percentile onboarding under 15 minutes, update/rollback success, routing correctness, semantic parity, policy evidence, and tool attribution before stable promotion.
