import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "@cipherpol/contracts";
import {
  admitPackage,
  admitPackageSet,
  type AdmissionGateInputs,
  CipherpolAdmissionError,
  type GeneratedPackageInput,
  generatePackageInputs,
  type ImportedArtifactDescriptor,
  importSoftwareDevAgenticArtifacts,
  loadImportPolicy,
  materializeClosure,
  type MaterializedClosure,
  type PackageAdmissionEnvelope,
  verifyAdmission,
  type PackageAdmissionInput,
  type SoftwareDevAgenticImportPolicy,
  type SoftwareDevAgenticImportResult,
} from "../src/index.js";

const checkedInPolicyPath = fileURLToPath(
  new URL("../../../fixtures/software-dev-agentic/import-policy.yaml", import.meta.url),
);

async function createArtifact(
  context: TestContext,
  files: Readonly<Record<string, string | Buffer>> = { "agent.md": "# Router\n" },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return root;
}

function createInput(
  signingKey: KeyObject,
  overrides: Partial<Omit<PackageAdmissionInput, "signingKey">> = {},
): PackageAdmissionInput {
  return {
    id: "acme/agents/router",
    kind: "agent",
    version: "1.0.0",
    owner: "platform-security",
    sourceRevision: "abc1234",
    artifactPath: "packages/acme/agents/router",
    compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
    dependencies: [],
    files: [{ source: "agent.md", target: "agents/router.md" }],
    provenance: {
      sourceRepository: "https://example.test/acme/agents.git",
      sourceRevision: "abc1234",
      sourcePaths: ["src/router", "agent.md", "src/router"],
    },
    keyId: "release-key-1",
    keyPurpose: "production",
    ...overrides,
    signingKey,
  };
}

async function createGateInputs(
  context: TestContext,
  input: PackageAdmissionInput,
  artifactRoot: string,
): Promise<AdmissionGateInputs> {
  const gateRoot = await mkdtemp(join(tmpdir(), "cipherpol-admission-gates-"));
  context.after(() => rm(gateRoot, { recursive: true, force: true }));
  const skillsDirectory = join(gateRoot, "skills");
  const agentsDirectory = join(gateRoot, "agents");
  await Promise.all([
    mkdir(join(skillsDirectory, "safe-skill"), { recursive: true }),
    mkdir(agentsDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(skillsDirectory, "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8"),
    writeFile(join(agentsDirectory, "safe-agent.md"), "# Safe agent\n", "utf8"),
  ]);

  const mappedRoot = input.kind === "agent"
    ? { prefix: "agents/", directory: agentsDirectory }
    : input.kind === "skill" || input.kind === "procedure"
      ? { prefix: "skills/", directory: skillsDirectory }
      : undefined;
  if (mappedRoot !== undefined) {
    for (const mapping of input.files) {
      if (!mapping.target.startsWith(mappedRoot.prefix)) {
        continue;
      }
      const gatePath = join(mappedRoot.directory, mapping.target.slice(mappedRoot.prefix.length));
      await mkdir(dirname(gatePath), { recursive: true });
      await writeFile(gatePath, await readFile(join(artifactRoot, mapping.source)));
    }
  }

  return {
    packageSet: [{ id: input.id, dependencies: input.dependencies }],
    skillsDirectory,
    agentsDirectory,
  };
}

async function admitForTest(
  context: TestContext,
  input: PackageAdmissionInput,
  artifactRoot: string,
): Promise<PackageAdmissionEnvelope> {
  return await admitPackage(
    input,
    artifactRoot,
    await createGateInputs(context, input, artifactRoot),
  );
}

async function captureAdmissionError(action: () => Promise<unknown>): Promise<CipherpolAdmissionError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof CipherpolAdmissionError);
    return error;
  }
  assert.fail("Expected CipherpolAdmissionError");
}

test("admits deterministically and verifies the measured artifact", async (context) => {
  const root = await createArtifact(context, {
    "agent.md": "# Router\n",
    "notes/info.txt": "Reviewed content\n",
    "opaque.bin": Buffer.from([0, 0xff, 0x01]),
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);

  const first = await admitForTest(context, input, root);
  const second = await admitForTest(context, input, root);

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.signature, second.signature);
  assert.match(first.packageRecord.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(first.provenance.sourcePaths, ["agent.md", "src/router"]);
  assert.deepEqual(await verifyAdmission(first, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: publicKey,
    allowFixtureKeys: false,
    artifactRoot: root,
  }), {
    valid: true,
    packageRecord: first.packageRecord,
    provenance: first.provenance,
    keyId: "release-key-1",
  });
  const expectedDigest = createHash("sha256");
  for (const [path, content] of [
    ["agent.md", Buffer.from("# Router\n")],
    ["notes/info.txt", Buffer.from("Reviewed content\n")],
    ["opaque.bin", Buffer.from([0, 0xff, 0x01])],
  ] as const) {
    expectedDigest.update(path);
    expectedDigest.update("\0");
    expectedDigest.update(content);
    expectedDigest.update("\0");
  }
  assert.equal(first.packageRecord.digest, `sha256:${expectedDigest.digest("hex")}`);
});

test("detects signed-content and artifact tampering", async (context) => {
  const root = await createArtifact(context);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = await admitForTest(context, createInput(privateKey), root);
  const tamperedEnvelope = {
    ...envelope,
    packageRecord: { ...envelope.packageRecord, owner: "attacker" },
  };

  const signatureError = await captureAdmissionError(() => verifyAdmission(tamperedEnvelope, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(signatureError.code, "SIGNATURE_INVALID");

  await writeFile(join(root, "agent.md"), "# Changed Router\n");
  const digestError = await captureAdmissionError(() => verifyAdmission(envelope, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: publicKey,
    allowFixtureKeys: false,
    artifactRoot: root,
  }));
  assert.equal(digestError.code, "DIGEST_MISMATCH");
});

test("rejects a wrong trusted key and key ID", async (context) => {
  const root = await createArtifact(context);
  const signer = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const envelope = await admitForTest(context, createInput(signer.privateKey), root);

  const wrongKeyId = await captureAdmissionError(() => verifyAdmission(envelope, {
    trustedKeyId: "different-key",
    trustedPublicKey: signer.publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(wrongKeyId.code, "UNTRUSTED_KEY");

  const wrongKey = await captureAdmissionError(() => verifyAdmission(envelope, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: other.publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(wrongKey.code, "SIGNATURE_INVALID");
});

test("binds the key ID into the signature payload", async (context) => {
  const root = await createArtifact(context);
  const signer = generateKeyPairSync("ed25519");
  const envelope = await admitForTest(context, createInput(signer.privateKey), root);
  const rewrittenIdentity = { ...envelope, keyId: "release-key-2" };

  const error = await captureAdmissionError(() => verifyAdmission(rewrittenIdentity, {
    trustedKeyId: "release-key-2",
    trustedPublicKey: signer.publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a fixture-purpose admission unless explicitly allowed, and admits/verifies it when allowed", async (context) => {
  const root = await createArtifact(context);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = await admitForTest(context, createInput(privateKey, { keyPurpose: "fixture" }), root);
  assert.equal(envelope.keyPurpose, "fixture");

  const rejected = await captureAdmissionError(() => verifyAdmission(envelope, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(rejected.code, "UNTRUSTED_KEY");

  const accepted = await verifyAdmission(envelope, {
    trustedKeyId: "release-key-1",
    trustedPublicKey: publicKey,
    allowFixtureKeys: true,
  });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.keyId, "release-key-1");
});

test("rejects a missing declared source file", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const validInput = createInput(privateKey);
  const gates = await createGateInputs(context, validInput, root);
  const input = createInput(privateKey, {
    files: [{ source: "missing.md", target: "agents/router.md" }],
  });

  const error = await captureAdmissionError(() => admitPackage(input, root, gates));
  assert.equal(error.code, "MISSING_SOURCE_FILE");
});

test("rejects symbolic links anywhere in the artifact", async (context) => {
  const root = await createArtifact(context);
  await symlink(join(root, "agent.md"), join(root, "linked.md"));
  const { privateKey } = generateKeyPairSync("ed25519");

  const error = await captureAdmissionError(() => admitForTest(context, createInput(privateKey), root));
  assert.equal(error.code, "UNSAFE_ARTIFACT_FILE");
  assert.equal(error.details["fileType"], "symbolic-link");
});

test("rejects normalized target collisions", async (context) => {
  const root = await createArtifact(context, {
    "agent.md": "# Router\n",
    "helper.md": "# Helper\n",
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey, {
    files: [
      { source: "agent.md", target: "agents/router.md" },
      { source: "helper.md", target: "agents/./router.md" },
    ],
  });

  const error = await captureAdmissionError(() => admitForTest(context, input, root));
  assert.equal(error.code, "TARGET_COLLISION");
});

test("scans and rejects secrets in undeclared artifact files", async (context) => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
  const root = await createArtifact(context, {
    "agent.md": "# Router\n",
    "undeclared.txt": `credential=${secret}\n`,
  });
  const { privateKey } = generateKeyPairSync("ed25519");

  const error = await captureAdmissionError(() => admitForTest(context, createInput(privateKey), root));
  assert.equal(error.code, "SECRET_DETECTED");
  assert.equal(error.details["filePath"], "undeclared.txt");
  assert.equal(error.message.includes(secret), false);
  assert.equal(canonicalJson(error.details).includes(secret), false);
});

test("rejects provenance revision mismatches before signing", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey, {
    provenance: {
      sourceRepository: "https://example.test/acme/agents.git",
      sourceRevision: "different-revision",
      sourcePaths: ["agent.md"],
    },
  });

  const error = await captureAdmissionError(() => admitForTest(context, input, root));
  assert.equal(error.code, "PROVENANCE_MISMATCH");
});

test("wraps artifact filesystem failures in typed admission errors", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);
  const gates = await createGateInputs(context, input, root);
  await rm(root, { recursive: true, force: true });

  const error = await captureAdmissionError(() => admitPackage(input, root, gates));
  assert.equal(error.code, "ARTIFACT_IO_ERROR");
  assert.equal(error.details["filesystemCode"], "ENOENT");
});

test("rejects malformed compatibility ranges and unsafe key IDs before signing", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");

  const malformedRange = await captureAdmissionError(() => admitForTest(
    context,
    createInput(privateKey, {
      compatibility: { claudeCode: "definitely not semver", capabilities: [] },
    }),
    root,
  ));
  assert.equal(malformedRange.code, "INVALID_ADMISSION");
  assert.equal(malformedRange.details["field"], "compatibility.claudeCode");

  const unsafeKeyId = await captureAdmissionError(() => admitForTest(
    context,
    createInput(privateKey, { keyId: "release-key\nforged" }),
    root,
  ));
  assert.equal(unsafeKeyId.code, "INVALID_ADMISSION");
});

test("production admission rejects unsafe procedure, agent, and dependency gates", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);

  const unsafeProcedureGates = await createGateInputs(context, input, root);
  await writeFile(
    join(unsafeProcedureGates.skillsDirectory, "safe-skill", "SKILL.md"),
    "$CLAUDE_PLUGIN_ROOT/skills/missing-skill/procedure.md\n",
    "utf8",
  );
  const procedureError = await captureAdmissionError(
    () => admitPackage(input, root, unsafeProcedureGates),
  );
  assert.equal(procedureError.code, "INVALID_PROCEDURE_GRAPH");

  const unsafeAgentGates = await createGateInputs(context, input, root);
  await writeFile(
    join(unsafeAgentGates.agentsDirectory, "developer-scout.md"),
    "---\ntools: Glob, Grep\n---\nSearch freely.\n",
    "utf8",
  );
  const agentError = await captureAdmissionError(
    () => admitPackage(input, root, unsafeAgentGates),
  );
  assert.equal(agentError.code, "INVALID_AGENT_CONTEXT");

  const cyclicInput = createInput(privateKey, {
    dependencies: ["acme/skills/helper@1.0.0"],
  });
  const cyclicGates = {
    ...await createGateInputs(context, cyclicInput, root),
    packageSet: [
      { id: cyclicInput.id, dependencies: cyclicInput.dependencies },
      {
        id: "acme/skills/helper",
        dependencies: [`${cyclicInput.id}@1.0.0`],
      },
    ],
  };
  const cycleError = await captureAdmissionError(
    () => admitPackage(cyclicInput, root, cyclicGates),
  );
  assert.equal(cycleError.code, "DEPENDENCY_CYCLE");
});

test("production admission fails closed when a required gate view is missing", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);
  const gates = await createGateInputs(context, input, root);

  const missingSkills = await captureAdmissionError(() => admitPackage(input, root, {
    ...gates,
    skillsDirectory: join(root, "missing-skills"),
  }));
  assert.equal(missingSkills.code, "INVALID_PROCEDURE_GRAPH");

  const missingAgents = await captureAdmissionError(() => admitPackage(input, root, {
    ...gates,
    agentsDirectory: join(root, "missing-agents"),
  }));
  assert.equal(missingAgents.code, "INVALID_AGENT_CONTEXT");
});

test("production admission binds the admitted package to the checked flat view", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);

  const absentGates = await createGateInputs(context, input, root);
  await rm(join(absentGates.agentsDirectory, "router.md"));
  const absentMember = await captureAdmissionError(
    () => admitPackage(input, root, absentGates),
  );
  assert.equal(absentMember.code, "INVALID_AGENT_CONTEXT");
  assert.equal(absentMember.details["reason"], "missing-gate-member");

  const mismatchedGates = await createGateInputs(context, input, root);
  await writeFile(
    join(mismatchedGates.agentsDirectory, "router.md"),
    "# Different agent\n",
    "utf8",
  );
  const mismatchedMember = await captureAdmissionError(
    () => admitPackage(input, root, mismatchedGates),
  );
  assert.equal(mismatchedMember.code, "INVALID_AGENT_CONTEXT");
  assert.equal(mismatchedMember.details["reason"], "gate-content-mismatch");
  const maliciousRoot = await createArtifact(context, {
    "agent.md": "---\ntools: Glob, Grep\n---\nSearch without project context.\n",
  });
  const maliciousInput = createInput(privateKey, {
    id: "acme/agents/developer-router",
    files: [{ source: "agent.md", target: "agents/developer-router.md" }],
  });
  const unrelatedSafeGates = await createGateInputs(context, maliciousInput, maliciousRoot);
  await writeFile(
    join(unrelatedSafeGates.agentsDirectory, "developer-router.md"),
    "---\ntools: Glob, Grep\n---\nUse project_root for every search.\n",
    "utf8",
  );
  const unrelatedSafeView = await captureAdmissionError(
    () => admitPackage(maliciousInput, maliciousRoot, unrelatedSafeGates),
  );
  assert.equal(unrelatedSafeView.code, "INVALID_AGENT_CONTEXT");
  assert.equal(unrelatedSafeView.details["reason"], "gate-content-mismatch");
});


test("binds every skill runtime file to the exact checked snapshot bytes", async (context) => {
  const skillBody = [
    "---",
    "allowed-tools: Read",
    "---",
    "$CLAUDE_PLUGIN_ROOT/skills/router-skill/procedure.md",
    "",
  ].join("\n");
  const procedureBody = [
    "> Executed by:",
    "> - `/router-skill` — invokes its procedure",
    "",
    "# Procedure",
    "",
  ].join("\n");
  const root = await createArtifact(context, {
    "SKILL.md": skillBody,
    "procedure.md": procedureBody,
    "references/policy.txt": "exact auxiliary bytes\n",
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey, {
    id: "acme/skills/router-skill",
    kind: "skill",
    artifactPath: "packages/acme/skills/router-skill",
    files: [
      { source: "SKILL.md", target: "skills/router-skill/SKILL.md" },
      { source: "procedure.md", target: "skills/router-skill/procedure.md" },
      {
        source: "references/policy.txt",
        target: "skills/router-skill/references/policy.txt",
      },
    ],
  });

  await assert.doesNotReject(admitForTest(context, input, root));
  const procedureInput = createInput(privateKey, {
    id: "acme/procedures/router-skill",
    kind: "procedure",
    artifactPath: "packages/acme/procedures/router-skill",
    files: input.files,
  });
  await assert.doesNotReject(admitForTest(context, procedureInput, root));

  const mismatchedGates = await createGateInputs(context, input, root);
  await writeFile(
    join(mismatchedGates.skillsDirectory, "router-skill", "references", "policy.txt"),
    "unrelated safe auxiliary bytes\n",
    "utf8",
  );
  const mismatched = await captureAdmissionError(
    () => admitPackage(input, root, mismatchedGates),
  );
  assert.equal(mismatched.code, "INVALID_PROCEDURE_GRAPH");
  assert.equal(mismatched.details["reason"], "gate-content-mismatch");

  const maliciousSkillRoot = await createArtifact(context, {
    "SKILL.md": "$CLAUDE_PLUGIN_ROOT/skills/missing/procedure.md\n",
  });
  const maliciousSkillInput = createInput(privateKey, {
    id: "acme/skills/malicious",
    kind: "skill",
    artifactPath: "packages/acme/skills/malicious",
    files: [{ source: "SKILL.md", target: "skills/malicious/SKILL.md" }],
  });
  const unrelatedSafeSkillGates = await createGateInputs(
    context,
    maliciousSkillInput,
    maliciousSkillRoot,
  );
  await writeFile(
    join(unrelatedSafeSkillGates.skillsDirectory, "malicious", "SKILL.md"),
    "# Unrelated safe skill\n",
    "utf8",
  );
  const unrelatedSafeSkillView = await captureAdmissionError(
    () => admitPackage(maliciousSkillInput, maliciousSkillRoot, unrelatedSafeSkillGates),
  );
  assert.equal(unrelatedSafeSkillView.code, "INVALID_PROCEDURE_GRAPH");
  assert.equal(unrelatedSafeSkillView.details["reason"], "gate-content-mismatch");

  const unrelatedGates = await createGateInputs(context, input, root);
  await rm(join(unrelatedGates.skillsDirectory, "router-skill"), {
    recursive: true,
    force: true,
  });
  const unrelated = await captureAdmissionError(
    () => admitPackage(input, root, unrelatedGates),
  );
  assert.equal(unrelated.code, "INVALID_PROCEDURE_GRAPH");
  assert.equal(unrelated.details["reason"], "missing-gate-member");
});

test("rejects symlinked gate targets, extra roots, and missing package entries", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey);

  const symlinkedGates = await createGateInputs(context, input, root);
  await rm(join(symlinkedGates.agentsDirectory, "router.md"));
  await symlink(
    join(symlinkedGates.agentsDirectory, "safe-agent.md"),
    join(symlinkedGates.agentsDirectory, "router.md"),
  );
  const symlinked = await captureAdmissionError(
    () => admitPackage(input, root, symlinkedGates),
  );
  assert.equal(symlinked.code, "INVALID_AGENT_CONTEXT");
  assert.equal(symlinked.details["reason"], "symbolic-link");

  const extraRootInput = createInput(privateKey, {
    files: [{ source: "agent.md", target: "references/router.md" }],
  });
  const extraRootGates = await createGateInputs(context, extraRootInput, root);
  const extraRoot = await captureAdmissionError(
    () => admitPackage(extraRootInput, root, extraRootGates),
  );
  assert.equal(extraRoot.code, "INVALID_AGENT_CONTEXT");
  assert.equal(extraRoot.details["reason"], "unexpected-gate-root");

  const missingEntryGates = await createGateInputs(context, input, root);
  const missingEntry = await captureAdmissionError(
    () => admitPackage(input, root, { ...missingEntryGates, packageSet: [] }),
  );
  assert.equal(missingEntry.code, "INVALID_ADMISSION");
  assert.equal(missingEntry.details["packageId"], input.id);
});

test("allows other roots but rejects mislabeled agent and skill targets", async (context) => {
  const root = await createArtifact(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const input = createInput(privateKey, {
    id: "acme/references/router",
    kind: "reference",
    artifactPath: "packages/acme/references/router",
    files: [{ source: "agent.md", target: "references/router.md" }],
  });

  await assert.doesNotReject(admitForTest(context, input, root));

  const mislabeledAgent = createInput(privateKey, {
    id: "acme/hooks/router",
    kind: "hook",
    artifactPath: "packages/acme/hooks/router",
    files: [{ source: "agent.md", target: "agents/router.md" }],
  });
  const mislabeledAgentGates = await createGateInputs(context, mislabeledAgent, root);
  const agentError = await captureAdmissionError(
    () => admitPackage(mislabeledAgent, root, mislabeledAgentGates),
  );
  assert.equal(agentError.code, "INVALID_AGENT_CONTEXT");
  assert.equal(agentError.details["reason"], "package-kind-mismatch");

  const mislabeledSkill = createInput(privateKey, {
    id: "acme/references/skill",
    kind: "reference",
    artifactPath: "packages/acme/references/skill",
    files: [{ source: "agent.md", target: "skills/mislabeled/SKILL.md" }],
  });
  const mislabeledSkillGates = await createGateInputs(context, mislabeledSkill, root);
  const skillError = await captureAdmissionError(
    () => admitPackage(mislabeledSkill, root, mislabeledSkillGates),
  );
  assert.equal(skillError.code, "INVALID_PROCEDURE_GRAPH");
  assert.equal(skillError.details["reason"], "package-kind-mismatch");
});

test("rejects a file whose metadata changes after its bytes are read", async (context) => {
  const root = await createArtifact(context);
  const artifactPath = join(root, "agent.md");
  const { privateKey } = generateKeyPairSync("ed25519");
  const probe = await open(artifactPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    readFile(): Promise<Buffer>;
  };
  const originalReadFile = fileHandlePrototype.readFile;
  await probe.close();
  fileHandlePrototype.readFile = async function readAndMutate(): Promise<Buffer> {
    const content = await originalReadFile.call(this);
    await appendFile(artifactPath, "changed\n", "utf8");
    return content;
  };

  try {
    const error = await captureAdmissionError(
      () => admitForTest(context, createInput(privateKey), root),
    );
    assert.equal(error.code, "UNSAFE_ARTIFACT_FILE");
    assert.equal(error.details["reason"], "changed-during-collection");
  } finally {
    fileHandlePrototype.readFile = originalReadFile;
  }
});

interface BatchPackageSpec {
  readonly input: Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose">;
  readonly artifactFiles: Readonly<Record<string, string | Buffer>>;
}

function batchInput(
  id: string,
  kind: PackageAdmissionInput["kind"],
  files: PackageAdmissionInput["files"],
  overrides: Partial<Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose" | "id" | "kind" | "files">> = {},
): Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose"> {
  return {
    id,
    kind,
    version: "1.0.0",
    owner: "platform-security",
    sourceRevision: "abc1234",
    artifactPath: `packages/${id}`,
    compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
    dependencies: [],
    files,
    provenance: {
      sourceRepository: "https://example.test/batch.git",
      sourceRevision: "abc1234",
      sourcePaths: files.map((file) => file.source),
    },
    ...overrides,
  };
}

function baseBatchSpecs(): BatchPackageSpec[] {
  return [
    {
      input: batchInput("acme.aegis/skill/router", "skill", [
        { source: "SKILL.md", target: "skills/router/SKILL.md" },
      ]),
      artifactFiles: { "SKILL.md": "# Router skill\n" },
    },
    {
      input: batchInput(
        "acme.aegis/agent/worker",
        "agent",
        [{ source: "worker.md", target: "agents/worker.md" }],
        { dependencies: ["acme.aegis/skill/router@1.0.0"] },
      ),
      artifactFiles: { "worker.md": "# Worker\n" },
    },
    {
      input: batchInput("acme.aegis/reference/guide", "reference", [
        { source: "guide.md", target: "reference/guide.md" },
      ]),
      artifactFiles: { "guide.md": "# Guide\n" },
    },
    {
      input: batchInput("acme.1/adapter/cp1", "adapter", [
        { source: "config.yml", target: "adapters/cp1/config.yml" },
      ]),
      artifactFiles: { "config.yml": "service: portable\n" },
    },
  ];
}

async function createBatchFixture(
  context: TestContext,
  specs: readonly BatchPackageSpec[],
): Promise<{ packages: GeneratedPackageInput[]; materialized: MaterializedClosure }> {
  const gateRoot = await mkdtemp(join(tmpdir(), "cipherpol-admission-batch-gates-"));
  context.after(() => rm(gateRoot, { recursive: true, force: true }));
  const skillsDirectory = join(gateRoot, "skills");
  const agentsDirectory = join(gateRoot, "agents");
  await mkdir(skillsDirectory, { recursive: true });
  await mkdir(agentsDirectory, { recursive: true });

  const packages: GeneratedPackageInput[] = [];
  for (const spec of specs) {
    const artifactRoot = await createArtifact(context, spec.artifactFiles);
    const mappedRoot = spec.input.kind === "agent"
      ? { prefix: "agents/", directory: agentsDirectory }
      : spec.input.kind === "skill" || spec.input.kind === "procedure"
        ? { prefix: "skills/", directory: skillsDirectory }
        : undefined;
    if (mappedRoot !== undefined) {
      for (const mapping of spec.input.files) {
        if (!mapping.target.startsWith(mappedRoot.prefix)) continue;
        const gatePath = join(mappedRoot.directory, mapping.target.slice(mappedRoot.prefix.length));
        await mkdir(dirname(gatePath), { recursive: true });
        await writeFile(gatePath, await readFile(join(artifactRoot, mapping.source)));
      }
    }
    packages.push({ input: spec.input, artifactRoot });
  }

  return {
    packages,
    materialized: { root: gateRoot, packages: [], skillsDirectory, agentsDirectory },
  };
}

test("admits a complete multi-kind package set as one deterministic gated batch", async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { packages, materialized } = await createBatchFixture(context, baseBatchSpecs());

  const first = await admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  });
  const second = await admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  });

  assert.equal(first.length, 4);
  assert.deepEqual(first.map((envelope) => envelope.packageRecord.id), [
    "acme.1/adapter/cp1",
    "acme.aegis/agent/worker",
    "acme.aegis/reference/guide",
    "acme.aegis/skill/router",
  ]);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  for (const envelope of first) {
    const artifactRoot = packages.find((candidate) => candidate.input.id === envelope.packageRecord.id)?.artifactRoot;
    assert.ok(artifactRoot);
    assert.deepEqual(
      await verifyAdmission(envelope, {
        trustedKeyId: "batch-key-1",
        trustedPublicKey: publicKey,
        allowFixtureKeys: false,
        artifactRoot,
      }),
      {
        valid: true,
        packageRecord: envelope.packageRecord,
        provenance: envelope.provenance,
        keyId: "batch-key-1",
      },
    );
  }
});

test("rejects the entire batch when one agent fails the working-context gate", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const maliciousSpec: BatchPackageSpec = {
    input: batchInput("acme.aegis/agent/developer-scout", "agent", [
      { source: "developer-scout.md", target: "agents/developer-scout.md" },
    ]),
    artifactFiles: {
      "developer-scout.md": "---\ntools: Glob, Grep\n---\nSearch without project context.\n",
    },
  };
  const { packages, materialized } = await createBatchFixture(context, [...baseBatchSpecs(), maliciousSpec]);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "INVALID_AGENT_CONTEXT");
});

test("rejects the entire batch when one skill fails the procedure graph gate", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const specs = baseBatchSpecs();
  const routerSpec = specs[0];
  assert.ok(routerSpec);
  specs[0] = {
    ...routerSpec,
    artifactFiles: { "SKILL.md": "$CLAUDE_PLUGIN_ROOT/skills/missing-skill/procedure.md\n" },
  };
  const { packages, materialized } = await createBatchFixture(context, specs);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "INVALID_PROCEDURE_GRAPH");
});

test("rejects the entire batch when packages declare a dependency cycle", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const specs = baseBatchSpecs();
  const routerSpec = specs[0];
  const guideSpec = specs[2];
  assert.ok(routerSpec);
  assert.ok(guideSpec);
  specs[0] = { ...routerSpec, input: { ...routerSpec.input, dependencies: ["acme.aegis/reference/guide@1.0.0"] } };
  specs[2] = { ...guideSpec, input: { ...guideSpec.input, dependencies: ["acme.aegis/skill/router@1.0.0"] } };
  const { packages, materialized } = await createBatchFixture(context, specs);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "DEPENDENCY_CYCLE");
});

test("rejects the entire batch when one artifact's bytes diverge from the checked snapshot", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const { packages, materialized } = await createBatchFixture(context, baseBatchSpecs());
  const skillPackage = packages.find((candidate) => candidate.input.id === "acme.aegis/skill/router");
  assert.ok(skillPackage);
  await writeFile(join(skillPackage.artifactRoot, "SKILL.md"), "# Tampered\n", "utf8");

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "INVALID_PROCEDURE_GRAPH");
  assert.equal(error.details["reason"], "gate-content-mismatch");
});

test("rejects the entire batch when one package declares an invalid file mode", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const specs = baseBatchSpecs();
  const guideSpec = specs[2];
  assert.ok(guideSpec);
  specs[2] = {
    ...guideSpec,
    input: {
      ...guideSpec.input,
      files: [
        { source: "guide.md", target: "reference/guide.md", mode: 0o600 },
      ] as unknown as PackageAdmissionInput["files"],
    },
  };
  const { packages, materialized } = await createBatchFixture(context, specs);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "INVALID_ADMISSION");
});

test("rejects the entire batch on a duplicate package ID", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const specs = baseBatchSpecs();
  const routerSpec = specs[0];
  const adapterSpec = specs[3];
  assert.ok(routerSpec);
  assert.ok(adapterSpec);
  specs[3] = { ...adapterSpec, input: { ...adapterSpec.input, id: routerSpec.input.id } };
  const { packages, materialized } = await createBatchFixture(context, specs);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "DUPLICATE_PACKAGE_ID");
});

test("rejects the entire batch on an unexpected package kind and target root", async (context) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const specs = baseBatchSpecs();
  const guideSpec = specs[2];
  assert.ok(guideSpec);
  specs[2] = {
    ...guideSpec,
    input: {
      ...guideSpec.input,
      files: [{ source: "guide.md", target: "agents/guide.md" }],
    },
  };
  const { packages, materialized } = await createBatchFixture(context, specs);

  const error = await captureAdmissionError(() => admitPackageSet({
    packages,
    materialized,
    signingKey: privateKey,
    keyId: "batch-key-1",
    keyPurpose: "production",
  }));
  assert.equal(error.code, "INVALID_AGENT_CONTEXT");
  assert.equal(error.details["reason"], "package-kind-mismatch");
});

async function writeSourceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test(
  "batch-admits a real generated package set end to end via materialize and generate",
  async (context) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "cipherpol-admission-e2e-source-"));
    context.after(() => rm(sourceRoot, { recursive: true, force: true }));
    await writeSourceFile(
      join(sourceRoot, "cipherpol-aegis/skills/router/SKILL.md"),
      "# Router skill\n",
    );
    await writeSourceFile(
      join(sourceRoot, "cipherpol-aegis/agents/worker.md"),
      "---\nname: worker\n---\n\n# Worker\n",
    );
    await writeSourceFile(
      join(sourceRoot, "cipherpol-aegis/reference/guide.md"),
      "# Portable guide\n",
    );
    await writeSourceFile(join(sourceRoot, "cipherpol-1/package.json"), "{\"name\": \"cp1\"}\n");
    await writeSourceFile(join(sourceRoot, "cipherpol-1/deploy/config.yml"), "service: cp1\n");
    await writeSourceFile(
      join(sourceRoot, "cipherpol-1/packages/server/src/server.ts"),
      "export const portableServer = \"cp1\";\n",
    );

    const artifacts: ImportedArtifactDescriptor[] = [
      {
        packageId: "acme.aegis/skill/router",
        parityIds: ["acme.aegis/orchestrator/router"],
        module: "cipherpol-aegis",
        moduleVersion: "16.0.1",
        packageKind: "skill",
        sourceKind: "directory",
        sourcePaths: ["cipherpol-aegis/skills/router"],
        targetRoot: "skills/router",
      },
      {
        packageId: "acme.aegis/agent/worker",
        parityIds: ["acme.aegis/agent/worker"],
        module: "cipherpol-aegis",
        moduleVersion: "16.0.1",
        packageKind: "agent",
        sourceKind: "file",
        sourcePaths: ["cipherpol-aegis/agents/worker.md"],
        targetRoot: "agents/worker.md",
      },
      {
        packageId: "acme.aegis/reference/guide",
        parityIds: ["acme.aegis/reference/guide"],
        module: "cipherpol-aegis",
        moduleVersion: "16.0.1",
        packageKind: "reference",
        sourceKind: "file",
        sourcePaths: ["cipherpol-aegis/reference/guide.md"],
        targetRoot: "reference/guide.md",
      },
      {
        packageId: "acme.1/adapter/cp1",
        parityIds: ["acme.1/mcp-tool/portable"],
        module: "cipherpol-1",
        moduleVersion: "0.2.0",
        packageKind: "adapter",
        sourceKind: "cp1-adapter",
        sourcePaths: [
          "cipherpol-1/package.json",
          "cipherpol-1/deploy",
          "cipherpol-1/packages/server/src",
        ],
        targetRoot: ".",
      },
    ];
    const imported = {
      sourceRevision: "abcdef01234",
      moduleVersions: { "cipherpol-aegis": "16.0.1", "cipherpol-9": "13.14.0", "cipherpol-1": "0.2.0" },
      entries: [],
      manifest: undefined,
      measured: undefined,
      artifacts,
    } as unknown as SoftwareDevAgenticImportResult;
    const module = { owner: "mobile-platform", packageVersion: "module-version" as const, claudeCode: ">=2.1.0 <3.0.0", capabilities: ["plugins"] };
    const policy: SoftwareDevAgenticImportPolicy = {
      schemaVersion: "cipherpol.import-policy/v1",
      modules: { "cipherpol-aegis": module, "cipherpol-9": module, "cipherpol-1": module },
      packageDependencies: {
        "acme.aegis/reference/guide": ["acme.aegis/skill/router@1.0.0"],
      },
    };

    const outputParent = await mkdtemp(join(tmpdir(), "cipherpol-admission-e2e-output-"));
    context.after(() => rm(outputParent, { recursive: true, force: true }));
    const materialized = await materializeClosure({
      sourceRoot,
      outputRoot: join(outputParent, "closure"),
      imported,
    });
    const generated = generatePackageInputs({
      imported,
      materialized,
      policy,
      sourceRepository: "https://example.test/software-dev-agentic.git",
    });
    assert.equal(generated.length, 4);

    const { privateKey } = generateKeyPairSync("ed25519");
    const first = await admitPackageSet({
      packages: generated,
      materialized,
      signingKey: privateKey,
      keyId: "closure-key-1",
      keyPurpose: "production",
    });
    const second = await admitPackageSet({
      packages: generated,
      materialized,
      signingKey: privateKey,
      keyId: "closure-key-1",
      keyPurpose: "production",
    });
    assert.equal(first.length, 4);
    assert.deepEqual(first.map((envelope) => envelope.packageRecord.id), [
      "acme.1/adapter/cp1",
      "acme.aegis/agent/worker",
      "acme.aegis/reference/guide",
      "acme.aegis/skill/router",
    ]);
    assert.equal(canonicalJson(first), canonicalJson(second));
  },
);

const realSourceRoot = process.env.SOFTWARE_DEV_AGENTIC_ROOT;
test("real authored source batch-admits the complete 152-package closure", {
  skip: realSourceRoot === undefined ? "SOFTWARE_DEV_AGENTIC_ROOT is not set" : false,
}, async (context) => {
  assert.ok(realSourceRoot);
  const imported = await importSoftwareDevAgenticArtifacts({
    repositoryRoot: realSourceRoot,
    sourceRevision: "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc",
  });
  const policy = await loadImportPolicy(checkedInPolicyPath);

  const outputParent = await mkdtemp(join(tmpdir(), "cipherpol-admission-real-"));
  context.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeClosure({
    sourceRoot: realSourceRoot,
    outputRoot: join(outputParent, "closure"),
    imported,
  });
  const generated = generatePackageInputs({
    imported,
    materialized,
    policy,
    sourceRepository: "https://github.com/example/software-dev-agentic.git",
  });
  assert.equal(generated.length, 152);

  const { privateKey } = generateKeyPairSync("ed25519");
  const envelopes = await admitPackageSet({
    packages: generated,
    materialized,
    signingKey: privateKey,
    keyId: "software-dev-agentic-real-key-1",
    keyPurpose: "production",
  });
  assert.equal(envelopes.length, 152);
  const ids = envelopes.map((envelope) => envelope.packageRecord.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, 152);
});
