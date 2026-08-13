import { createHash } from "node:crypto";
import {
  canonicalJson, generationSchema,
  type CipherpolManifest, type Generation, type PackageRecord, type RegistryIndex,
} from "@cipherpol/contracts";
import { maxSatisfying, satisfies } from "semver";
import { CipherpolError } from "./errors.js";

export interface Client { claudeCodeVersion: string; capabilities: ReadonlySet<string> }
const ref = (value: string) => ({ id: value.slice(0, value.lastIndexOf("@")), range: value.slice(value.lastIndexOf("@") + 1) });

function latest<T extends { id: string; version: string; revoked: boolean }>(items: T[], id: string, manifest: CipherpolManifest): T {
  const candidates = items.filter((item) => item.id === id && !item.revoked);
  const range = manifest.pins?.[id] ?? (manifest.channel === "canary" ? ">=0.0.0-0" : "*");
  const selectedVersion = maxSatisfying(candidates.map(({ version }) => version), range, {
    includePrerelease: manifest.channel === "canary",
  });
  const selected = candidates.find(({ version }) => version === selectedVersion);
  if (!selected) throw new CipherpolError("UNRESOLVABLE_GENERATION", `No eligible ${id}`);
  return selected;
}

function selectPackage(reference: string, manifest: CipherpolManifest, registry: RegistryIndex, client: Client): PackageRecord {
  const parsed = ref(reference);
  const range = manifest.pins?.[parsed.id] ?? parsed.range;
  const candidates = registry.packages.filter((item) => item.id === parsed.id && !item.revoked &&
    satisfies(item.version, range, { includePrerelease: manifest.channel === "canary" }) &&
    satisfies(client.claudeCodeVersion, item.compatibility.claudeCode) &&
    item.compatibility.capabilities.every((capability) => client.capabilities.has(capability)));
  const selectedVersion = maxSatisfying(candidates.map(({ version }) => version), range, {
    includePrerelease: manifest.channel === "canary",
  });
  const selected = candidates.find(({ version }) => version === selectedVersion);
  if (!selected) throw new CipherpolError("UNRESOLVABLE_GENERATION", `No compatible package ${reference}`);
  return selected;
}

export function resolveGeneration(manifest: CipherpolManifest, registry: RegistryIndex, client: Client): Generation {
  const packs = manifest.capabilityPacks.map((id) => latest(registry.capabilityPacks, id, manifest));
  for (const pack of packs) if (!pack.platforms.some((platform) => manifest.platforms.includes(platform as never) || platform === "generic")) {
    throw new CipherpolError("UNRESOLVABLE_GENERATION", `${pack.id} does not support this project`);
  }
  const playbookIds = new Set([...manifest.playbooks, ...packs.flatMap((pack) => pack.playbooks.map((item) => ref(item).id))]);
  const playbooks = [...playbookIds].map((id) => latest(registry.playbooks, id, manifest));
  const selected = new Map<string, PackageRecord>();
  const visit = (reference: string): void => {
    const candidate = selectPackage(reference, manifest, registry, client);
    const current = selected.get(candidate.id);
    if (current && current.version !== candidate.version) throw new CipherpolError("UNRESOLVABLE_GENERATION", `Version conflict ${candidate.id}`);
    if (!current) { selected.set(candidate.id, candidate); candidate.dependencies.forEach(visit); }
  };
  packs.flatMap((pack) => [pack.orchestrator, ...pack.packages]).forEach(visit);
  playbooks.flatMap((book) => [...book.guidancePackages, ...book.hookPackages, ...book.validatorPackages]).forEach(visit);
  const body = {
    schemaVersion: "cipherpol.generation/v1" as const,
    project: manifest.project,
    channel: manifest.channel,
    capabilityPacks: packs.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    playbooks: playbooks.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    packages: [...selected.values()].sort((a, b) => a.id.localeCompare(b.id)).map(
      ({ id, kind, version, digest, artifactPath, files }) => ({ id, kind, version, digest, artifactPath, files }),
    ),
    toolBundles: [...new Set(packs.flatMap((pack) => pack.toolBundle ? [pack.toolBundle] : []))].sort(),
    requiredEvidence: [...new Set(packs.flatMap((pack) => pack.requiredEvidence))].sort(),
  };
  return generationSchema.parse({
    ...body,
    generationId: `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`,
  });
}
