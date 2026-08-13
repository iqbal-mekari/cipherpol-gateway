# Cipherpol Gateway

Cipherpol distributes versioned engineering agents, skills, playbooks, and governed MCP access. The approved architecture is in `docs/superpowers/specs/2026-08-13-cipherpol-gateway-design.md`.

## Stage 1 verification

```bash
pnpm install
pnpm verify
pnpm smoke:local
```

Stage 1 uses a local filesystem registry. It performs no SSO, network, database, signature, or MCP operation. `update --check` is read-only; activation requires explicit `setup --yes`.
