import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listProjects,
  listRefs,
  getProjectIdBySlug,
  getSymbol,
  deleteMemories,
  listMemories,
  getMemoryById,
  upsertSkill,
  listSkills,
  getSkillsWithEmbeddings,
  deleteSkill,
} from "@kb/db";
import { embedQuery, embedDocuments } from "@kb/embeddings";
import { search, searchDocs, symbolCard, neighborsCard, impactCard, diffRefsCard, docsForSymbol, codeForDoc } from "@kb/retrieval";
import { captureRaw, readLog, storeMemories, recall, removeSessionDir } from "@kb/memory";
import { config, type MemoryKind } from "@kb/core";

/** Wrap a handler: return markdown text, or a clean error block. */
function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

/** Resolve a symbol identifier (id, or fqn within a ref) to a db symbol id. */
async function resolveSymbolId(slug: string, id?: string, fqn?: string, ref?: string): Promise<string> {
  if (id) return id;
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);
  const s = await getSymbol(projectId, { fqn, ref });
  if (!s) throw new Error(`Symbol not found: ${fqn}`);
  return s.id;
}

const KINDS = ["decision", "fact", "pattern", "todo", "gotcha"] as const;

/** Build a fresh, fully-registered MCP server instance. Called once for the
 * stdio transport (one process per client), or once per request for the
 * stateless HTTP transport (no cross-request state is held on `server`). */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "ai-knowledge-base", version: "0.1.0" });

  // 1. list_projects ----------------------------------------------------------
  server.registerTool(
    "list_projects",
    { description: "List indexed projects and the refs (branches/tags/user snapshots) available for each.", inputSchema: {} },
    async () => {
      try {
        const rows = await listProjects();
        if (rows.length === 0) return text("No projects indexed yet. Use the index-project skill/script to add one.");
        const lines = ["| slug | name | refs |", "|---|---|---|"];
        for (const r of rows) {
          const refs = await listRefs(r.id);
          lines.push(`| ${r.slug} | ${r.name} | ${refs.join(", ") || "—"} |`);
        }
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 2. search (core GraphRAG) -------------------------------------------------
  server.registerTool(
    "search",
    {
      description:
        "Ask a natural-language question about a codebase. Returns the most relevant code (vector similarity) plus graph-expanded neighbors (callers/callees). The primary retrieval tool.",
      inputSchema: {
        slug: z.string(),
        query: z.string().describe("Natural-language question, e.g. 'how does auth work?'"),
        ref: z.string().optional().describe("Snapshot ref to search (default branch:main)."),
        k: z.number().int().min(1).max(30).optional().describe("Number of seed results (default 8)."),
        expand_hops: z.number().int().min(0).max(2).optional().describe("Graph expansion depth (default 1)."),
        kinds: z.array(z.string()).optional().describe("Filter by symbol kinds, e.g. ['function','method']."),
      },
    },
    async ({ slug, query, ref, k, expand_hops, kinds }) => {
      try {
        const r = await search(slug, query, { ref, k, expandHops: expand_hops, kinds });
        return text(r.markdown);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 2b. search_docs (documentation) ------------------------------------------
  server.registerTool(
    "search_docs",
    {
      description:
        "Search documentation — PRDs, RFCs, ADRs, standards, references — for a project. Use this for requirements, conventions, and how things are *meant* to work; use `search` for code/implementation. Returns the most relevant doc sections with their heading breadcrumb.",
      inputSchema: {
        slug: z.string(),
        query: z.string().describe("Natural-language question, e.g. 'what are the API base URLs?'"),
        doc_type: z
          .array(z.string())
          .optional()
          .describe("Filter by doc types: prd|rfc|adr|standard|guide|runbook|design|spec|reference|other."),
        platform: z
          .array(z.string())
          .optional()
          .describe("Filter by platform: flutter|ios|android|web|backend|shared."),
        integration: z.enum(["standalone", "embedded"]).optional().describe("Filter by mobile integration mode."),
        status: z.enum(["draft", "active", "deprecated", "superseded"]).optional().describe("Filter by lifecycle status."),
        ref: z.string().optional().describe("Docs snapshot ref (default docs:latest)."),
        k: z.number().int().min(1).max(30).optional().describe("Number of results (default 6)."),
      },
    },
    async ({ slug, query, doc_type, platform, integration, status, ref, k }) => {
      try {
        const r = await searchDocs(slug, query, {
          ref,
          k,
          docTypes: doc_type,
          platform,
          integration,
          status,
        });
        return text(r.markdown);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 3. get_symbol -------------------------------------------------------------
  server.registerTool(
    "get_symbol",
    {
      description: "Fetch the verbatim source + metadata for a symbol by fqn (within a ref) or id.",
      inputSchema: {
        slug: z.string(),
        fqn: z.string().optional().describe("Fully-qualified name, e.g. 'billing.PaymentService.charge'."),
        id: z.string().optional().describe("Symbol id (from a prior search/neighbors result)."),
        ref: z.string().optional().describe("Ref to disambiguate fqn lookups (default branch:main)."),
      },
    },
    async ({ slug, fqn, id, ref }) => {
      try {
        return text(await symbolCard(slug, { id, fqn, ref: fqn ? ref ?? config.defaultRef() : undefined }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 4. get_neighbors ----------------------------------------------------------
  server.registerTool(
    "get_neighbors",
    {
      description: "Show a symbol's direct callers and callees (and other edges), grouped by direction.",
      inputSchema: {
        slug: z.string(),
        id: z.string().optional().describe("Symbol id."),
        fqn: z.string().optional().describe("Fully-qualified name (resolved to id within ref)."),
        ref: z.string().optional().describe("Ref for fqn resolution (default branch:main)."),
      },
    },
    async ({ slug, id, fqn, ref }) => {
      try {
        return text(await neighborsCard(slug, await resolveSymbolId(slug, id, fqn, ref ?? config.defaultRef())));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 5. impact (blast radius) --------------------------------------------------
  server.registerTool(
    "impact",
    {
      description: "Blast radius: everything that transitively depends on a symbol (who breaks if it changes).",
      inputSchema: {
        slug: z.string(),
        id: z.string().optional(),
        fqn: z.string().optional(),
        ref: z.string().optional().describe("Ref for fqn resolution (default branch:main)."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Traversal depth (default 3)."),
      },
    },
    async ({ slug, id, fqn, ref, max_depth }) => {
      try {
        return text(await impactCard(slug, await resolveSymbolId(slug, id, fqn, ref ?? config.defaultRef()), max_depth ?? 3));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 5b. doc_code_links (doc ↔ code) ------------------------------------------
  server.registerTool(
    "doc_code_links",
    {
      description:
        "Cross-link documentation and code. Pass `fqn` to find docs that document a code symbol ('the requirement behind this code'); pass `doc_id` to find the code a doc points at ('the code implementing this requirement'). Links are declared via a doc's related_symbols and span the docs/code refs.",
      inputSchema: {
        slug: z.string(),
        fqn: z.string().optional().describe("Code symbol fqn → returns docs that reference it."),
        doc_id: z.string().optional().describe("Doc id (e.g. local:… / confluence:…) → returns the code symbols it documents."),
      },
    },
    async ({ slug, fqn, doc_id }) => {
      try {
        if (fqn) return text((await docsForSymbol(slug, fqn)).markdown);
        if (doc_id) return text((await codeForDoc(slug, doc_id)).markdown);
        return text("Provide either `fqn` (code→docs) or `doc_id` (doc→code).");
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 5c. diff_refs (ref/snapshot diff) ----------------------------------------
  server.registerTool(
    "diff_refs",
    {
      description:
        "Diff two refs (snapshots) of the same project: symbols added, removed, or changed (signature/source), grouped by file. Use this to compare e.g. branch:main against tag:v1.2.0, or two user snapshots.",
      inputSchema: {
        slug: z.string(),
        ref_a: z.string().describe("Base ref, e.g. 'tag:v1.2.0'."),
        ref_b: z.string().describe("Ref to compare against ref_a, e.g. 'branch:main'."),
        path_prefix: z.string().optional().describe("Restrict the diff to files whose path starts with this prefix."),
      },
    },
    async ({ slug, ref_a, ref_b, path_prefix }) => {
      try {
        return text(await diffRefsCard(slug, ref_a, ref_b, path_prefix));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 6. get_session_log --------------------------------------------------------
  server.registerTool(
    "get_session_log",
    {
      description:
        "Return a session's raw log. Used by the distill-session skill: the HOST reads this, extracts durable memories, and stores each via store_memory. No second LLM runs server-side.",
      inputSchema: {
        slug: z.string(),
        session_id: z.string(),
      },
    },
    async ({ slug, session_id }) => {
      try {
        const log = await readLog(slug, session_id);
        return text(log || "_(empty session log)_");
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 7. store_memory -----------------------------------------------------------
  server.registerTool(
    "store_memory",
    {
      description:
        "Persist session memory. Provide raw_log to append to the session's raw log (cheap, lossless). Provide memory to store one typed durable memory (embedded + written as an artifact under logs/<session>/). Distillation itself is done by the host — see the distill-session skill.",
      inputSchema: {
        slug: z.string(),
        session_id: z.string(),
        raw_log: z.string().optional().describe("Raw text to append to the session log."),
        memory: z
          .object({
            kind: z.enum(KINDS),
            title: z.string(),
            content: z.string(),
            confidence: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe("A single typed durable memory to store directly."),
      },
    },
    async ({ slug, session_id, raw_log, memory }) => {
      try {
        const out: string[] = [];
        if (raw_log) {
          const p = await captureRaw(slug, session_id, raw_log);
          out.push(`Appended ${raw_log.length} chars to ${p}.`);
        }
        if (memory) {
          const ids = await storeMemories(slug, session_id, [memory]);
          out.push(`Stored ${memory.kind} memory (${ids[0]}).`);
        }
        return text(out.length ? out.join("\n") : "Nothing to store (provide raw_log and/or memory).");
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 8. recall_memory ----------------------------------------------------------
  server.registerTool(
    "recall_memory",
    {
      description: "Recall durable memories for a project, ranked by relevance + recency. Scoped to the project (never leaks across projects).",
      inputSchema: {
        slug: z.string(),
        query: z.string(),
        types: z.array(z.enum(KINDS)).optional().describe("Filter by memory kinds."),
        k: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ slug, query, types, k }) => {
      try {
        const r = await recall(slug, query, { kinds: types as MemoryKind[] | undefined, k });
        return text(r.markdown);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 9. list_memories ---------------------------------------------------------
  server.registerTool(
    "list_memories",
    {
      description:
        "List all stored memories for a project, newest first. Filter by kind and/or session_id. Supports pagination via limit + offset.",
      inputSchema: {
        slug: z.string(),
        kind: z.enum(["decision", "fact", "pattern", "todo", "gotcha"]).optional().describe("Filter by memory kind."),
        session_id: z.string().optional().describe("Filter to a specific session's memories."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
      },
    },
    async ({ slug, kind, session_id, limit, offset }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);
        const rows = await listMemories(projectId, { kind, session: session_id, limit, offset });
        if (rows.length === 0) return text("No memories found.");
        const lines = ["| id | session | kind | title | confidence | created_at |", "|---|---|---|---|---|---|"];
        for (const r of rows) {
          const superseded = r.superseded_by ? " *(superseded)*" : "";
          lines.push(
            `| ${r.id.slice(0, 8)} | ${r.session_id} | ${r.kind} | ${r.title ?? "—"}${superseded} | ${r.confidence.toFixed(2)} | ${r.created_at.slice(0, 10)} |`,
          );
        }
        lines.push(`\n_${rows.length} result(s)${offset ? ` (offset ${offset})` : ""}._`);
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 10. store_skill -----------------------------------------------------------
  server.registerTool(
    "store_skill",
    {
      description:
        "Create or update a skill for a project. A skill is a reusable piece of project-level knowledge: a how-to, pattern, script, or reference. Identified by slug (stable key). Content is free-form markdown — embed scripts as fenced code blocks.",
      inputSchema: {
        slug: z.string().describe("Project slug."),
        skill_slug: z.string().describe("Stable identifier for this skill, e.g. 'reindex-all' or 'auth-pattern'."),
        title: z.string().describe("Human-readable name."),
        content: z.string().describe("Skill content in markdown. Embed scripts as fenced code blocks."),
        metadata: z.record(z.unknown()).optional().describe("Optional tags or extra fields (JSON object)."),
      },
    },
    async ({ slug, skill_slug, title, content, metadata }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);
        const [embedding] = await embedDocuments([`${title}\n${content}`]);
        const id = await upsertSkill(projectId, skill_slug, title, content, embedding!, metadata as Record<string, unknown> ?? {});
        return text(`Stored skill **${skill_slug}** (id: ${id}) for project **${slug}**.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 11. list_skills ------------------------------------------------------------
  server.registerTool(
    "list_skills",
    {
      description: "List all skills stored for a project.",
      inputSchema: {
        slug: z.string(),
      },
    },
    async ({ slug }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);
        const rows = await listSkills(projectId);
        if (rows.length === 0) return text(`No skills stored for **${slug}** yet. Use store_skill to add one.`);
        const lines = ["| slug | title | updated |", "|---|---|---|"];
        for (const r of rows) {
          lines.push(`| ${r.slug} | ${r.title} | ${r.updated_at.slice(0, 10)} |`);
        }
        lines.push(`\n_${rows.length} skill(s)._`);
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 12. recall_skill -----------------------------------------------------------
  server.registerTool(
    "recall_skill",
    {
      description: "Retrieve skills by semantic similarity to a query. Returns the top matching skills with their full content.",
      inputSchema: {
        slug: z.string(),
        query: z.string().describe("Natural-language question, e.g. 'how do I re-index a project?'"),
        k: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
      },
    },
    async ({ slug, query, k }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);
        const skills = await getSkillsWithEmbeddings(projectId);
        if (skills.length === 0) return text(`No skills stored for **${slug}** yet.`);

        const queryVec = await embedQuery(query);
        const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
        const norm = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
        const cosSim = (a: number[], b: number[]) => dot(a, b) / (norm(a) * norm(b) || 1);

        const ranked = skills
          .map((s) => ({ ...s, score: s.embedding ? cosSim(queryVec, s.embedding) : 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k ?? 5);

        const lines = [`# Skills for ${slug}: "${query}"`, ""];
        for (const s of ranked) {
          lines.push(`## ${s.title} \`${s.slug}\``);
          lines.push(`_score ${s.score.toFixed(3)} · updated ${s.updated_at.slice(0, 10)}_`);
          lines.push("");
          lines.push(s.content);
          lines.push("");
        }
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 13. delete_skill -----------------------------------------------------------
  server.registerTool(
    "delete_skill",
    {
      description:
        "Delete a skill. Always requires confirm:true — the tool first shows what will be deleted; re-run with confirm:true to proceed.",
      inputSchema: {
        slug: z.string(),
        skill_slug: z.string().optional().describe("Delete this specific skill. Omit to delete ALL skills for the project."),
        confirm: z.boolean().optional().describe("Must be true to execute the deletion. Without it, a preview is shown."),
      },
    },
    async ({ slug, skill_slug, confirm }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);
        const skills = await listSkills(projectId);

        if (skill_slug) {
          const skill = skills.find((s) => s.slug === skill_slug);
          if (!skill) return text(`Skill '${skill_slug}' not found in project '${slug}'.`);
          if (!confirm) {
            return text(
              `⚠️ **Confirm deletion**\n\n` +
              `You are about to delete skill **"${skill.title}"** (\`${skill_slug}\`) from project **${slug}**.\n\n` +
              `Re-run with \`confirm: true\` to proceed.`,
            );
          }
          await deleteSkill(projectId, { slug: skill_slug });
          return text(`Deleted skill **${skill.title}** (\`${skill_slug}\`).`);
        }

        if (!confirm) {
          const names = skills.map((s) => `- \`${s.slug}\` — ${s.title}`).join("\n") || "_(none)_";
          return text(
            `⚠️ **Confirm deletion**\n\n` +
            `You are about to delete **ALL ${skills.length} skills** for project **${slug}**:\n\n${names}\n\n` +
            `Re-run with \`confirm: true\` to proceed.`,
          );
        }
        const n = await deleteSkill(projectId, {});
        return text(`Deleted all ${n} skills for project **${slug}**.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 14. delete_memory ---------------------------------------------------------
  server.registerTool(
    "delete_memory",
    {
      description:
        "Delete memories for a project. Always requires confirm:true — shows a preview first, then re-run with confirm:true to execute. Provide `id` for one memory, `session_id` for a whole session, or neither to delete ALL memories.",
      inputSchema: {
        slug: z.string(),
        id: z.string().optional().describe("Delete a single memory by id."),
        session_id: z.string().optional().describe("Delete all memories for this session (and its log folder)."),
        confirm: z.boolean().optional().describe("Must be true to execute the deletion. Without it, a preview is shown."),
      },
    },
    async ({ slug, id, session_id, confirm }) => {
      try {
        const projectId = await getProjectIdBySlug(slug);
        if (!projectId) return text(`Project '${slug}' not found.`);

        if (id) {
          const memory = await getMemoryById(id);
          if (!memory) return text(`No memory with id '${id}' found.`);
          if (!confirm) {
            return text(
              `⚠️ **Confirm deletion**\n\n` +
              `You are about to delete this memory from project **${slug}**:\n\n` +
              `- **Kind:** ${memory.kind}\n` +
              `- **Title:** ${memory.title ?? "(untitled)"}\n` +
              `- **Session:** ${memory.session_id}\n` +
              `- **Preview:** ${memory.content.slice(0, 120)}${memory.content.length > 120 ? "…" : ""}\n\n` +
              `Re-run with \`confirm: true\` to proceed.`,
            );
          }
          await deleteMemories(projectId, { id });
          return text(`Deleted memory **${memory.title ?? id}**.`);
        }

        if (session_id) {
          const rows = await listMemories(projectId, { session: session_id, limit: 200 });
          if (rows.length === 0) return text(`No memories found for session '${session_id}'.`);
          if (!confirm) {
            const preview = rows.slice(0, 5).map((r) => `- [${r.kind}] ${r.title ?? "(untitled)"}`).join("\n");
            const more = rows.length > 5 ? `\n- … and ${rows.length - 5} more` : "";
            return text(
              `⚠️ **Confirm deletion**\n\n` +
              `You are about to delete **${rows.length} memories** for session \`${session_id}\` and remove its log folder:\n\n${preview}${more}\n\n` +
              `Re-run with \`confirm: true\` to proceed.`,
            );
          }
          const n = await deleteMemories(projectId, { session: session_id });
          await removeSessionDir(slug, session_id);
          return text(`Deleted ${n} memories for session '${session_id}' and removed its log folder.`);
        }

        const rows = await listMemories(projectId, { limit: 200 });
        if (!confirm) {
          return text(
            `⚠️ **Confirm deletion**\n\n` +
            `You are about to delete **ALL ${rows.length}${rows.length === 200 ? "+" : ""} memories** for project **${slug}**. This cannot be undone.\n\n` +
            `Re-run with \`confirm: true\` to proceed.`,
          );
        }
        const n = await deleteMemories(projectId, {});
        return text(`Deleted all ${n} memories for project '${slug}'.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
