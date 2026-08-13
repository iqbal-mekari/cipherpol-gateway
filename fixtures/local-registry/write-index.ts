import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestDirectory } from "../../packages/resolver/src/index.js";

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const router = await digestDirectory(join(root, "artifacts/task-router"));
  const skill = await digestDirectory(join(root, "artifacts/general-skill"));
  const index = `schemaVersion: cipherpol.registry/v1
packages:
  - id: cipherpol.aegis/agent/task-router
    kind: agent
    version: 1.0.0
    digest: ${router}
    owner: mobile-platform
    sourceRevision: 4685ccb
    artifactPath: artifacts/task-router
    compatibility:
      claudeCode: ">=2.1.0 <3.0.0"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: task-router.md
        target: agents/task-router.md
  - id: cipherpol.aegis/skill/general-engineering
    kind: skill
    version: 1.0.0
    digest: ${skill}
    owner: mobile-platform
    sourceRevision: 4685ccb
    artifactPath: artifacts/general-skill
    compatibility:
      claudeCode: ">=2.1.0 <3.0.0"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: SKILL.md
        target: skills/cipherpol-general-engineering/SKILL.md
capabilityPacks:
  - id: cipherpol.aegis/pack/general
    version: 1.0.0
    intents: [engineering]
    platforms: [flutter, android, ios, web-nextjs, generic]
    orchestrator: cipherpol.aegis/agent/task-router@^1.0.0
    packages:
      - cipherpol.aegis/agent/task-router@^1.0.0
      - cipherpol.aegis/skill/general-engineering@^1.0.0
    playbooks: []
    requiredEvidence: [focused-validation]
playbooks: []
`;
  await writeFile(join(root, "index.yaml"), index);
  console.log(router);
  console.log(skill);
}

main().catch(console.error);
