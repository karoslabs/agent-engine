import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { z } from "zod";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { LinkedInDraftAgent } from "../src/agent/linkedin-draft-agent.js";
import { fakeRouterSequence, finalTurn, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, "..", "src");

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring", metadata: {} };

function sampleDraft() {
  return {
    headline: "A headline",
    hook: "A hook.",
    body: "A body.",
    hashtags: ["Topic"],
    callToAction: "Do something.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "Operations leaders",
    archetype: "teardown-framework" as const,
    text: "A hook.\n\nA body.\n\nDo something.\n\n#Topic",
  };
}

describe("PromptStore resolution (RFC-01 §16.1)", () => {
  it("resolves 'linkedin-craft@1' to the real prompts/linkedin-craft/1.md file content", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("linkedin-craft", "1");
    expect(resolved).toContain("Hook construction");
    expect(resolved).toContain("One post, one run");
  });

  it("resolves 'linkedin-craft' (no version) to prompts/linkedin-craft/latest.md", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("linkedin-craft");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("LinkedInDraftAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(sampleDraft())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new LinkedInDraftAgent(runtime);

    await agent.run(ctx, {});

    // Pinned to "linkedin-craft@5" (research digest, trend candidate, content
    // mode, attached media, the shape spec and the takeaway) -- every earlier
    // version stays on disk as a frozen baseline, never resolved again.
    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "linkedin-craft", "5.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = call[3] as { system?: string };
    expect(opts.system?.startsWith(`${expectedPrompt}\n\n`)).toBe(true);
  });

  it("produces tooling_error, not a crash, when skillRef names a prompt the store doesn't have", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, {
      id: "broken-skill-probe",
      description: "probe",
      allowedTools: [],
      outputSchema: z.object({ text: z.string() }),
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      skillRef: "does-not-exist@99",
    });
    const result = await agent.run(ctx, {});
    expect(result.status).toBe("tooling_error");
  });
});

describe("zero hardcoded prompts (RFC-01 §16.1)", () => {
  function listTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...listTsFiles(full));
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
    return files;
  }

  // Distinctive phrases from prompts/linkedin-craft/5.md (the live pinned
  // version — see prompt-resolution tests above) — if any of these appear in
  // TypeScript source, the craft content has been duplicated as a literal
  // instead of living only in the markdown file resolved via PromptStore.
  const CRAFT_CONTENT_MARKERS = [
    "the fold arrives well before 300 characters",
    "hook a reader has seen a hundred times earns zero taps",
    "never invent a plausible-sounding statistic",
    "No competitor names, ever, even neutrally",
  ];

  it("sanity check: the markers really do appear in the prompt file (so the negative check below is meaningful)", () => {
    const promptContent = readFileSync(path.join(PROMPTS_ROOT, "linkedin-craft", "5.md"), "utf8");
    for (const marker of CRAFT_CONTENT_MARKERS) {
      expect(promptContent.includes(marker), `expected "${marker}" to actually be in linkedin-craft/1.md`).toBe(true);
    }
  });

  it("contains no literal craft-content strings anywhere in src/", () => {
    const sourceFiles = listTsFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      for (const marker of CRAFT_CONTENT_MARKERS) {
        expect(content.includes(marker), `${file} appears to embed craft content ("${marker}") as a literal`).toBe(false);
      }
    }
  });

  it("LinkedInDraftAgent's config carries a skillRef, not an inline system prompt field", () => {
    const configSource = readFileSync(path.join(SRC_ROOT, "agent", "linkedin-draft-agent.ts"), "utf8");
    expect(configSource).toMatch(/skillRef:\s*"linkedin-craft@5"/);
  });
});
