import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { z } from "zod";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { XDraftAgent } from "../src/agent/x-draft-agent.js";
import { fakeRouterSequence, finalTurn, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, "..", "src");

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

describe("PromptStore resolution (RFC-01 §16.1)", () => {
  it("resolves 'x-craft@1' to the real prompts/x-craft/1.md file content", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("x-craft", "1");
    expect(resolved).toContain("Hook construction");
    expect(resolved).toContain("One post, one run");
  });

  it("resolves 'x-craft' (no version) to prompts/x-craft/latest.md", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("x-craft");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("XDraftAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn({ text: "A post.", mainPostText: "A post.", hook: "A post.", angle: "trend-observation", lane: "knowledge", targetHandle: "@acmehq" }),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new XDraftAgent(runtime);

    await agent.run(ctx, {});

    // XDraftAgent pins "x-craft@5" (the research digest, trend candidate,
    // content mode, attached media, threads and the media brief) — every
    // earlier version is kept frozen and never resolved at runtime.
    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "x-craft", "5.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the skill content is the
    // prefix, not that `system` equals it exactly.
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = call[3] as { system?: string };
    expect(opts.system?.startsWith(`${expectedPrompt}\n\n`)).toBe(true);
  });

  it("produces tooling_error, not a crash, when skillRef names a prompt the store doesn't have", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    // A MockAgent with the same skillRef convention but pointed at a nonexistent id/version.
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

  // Distinctive phrases from prompts/x-craft/5.md (the version XDraftAgent's
  // skillRef actually pins) — if any of these appear in TypeScript source,
  // the craft content has been duplicated as a literal instead of living
  // only in the markdown file resolved via PromptStore.
  const CRAFT_CONTENT_MARKERS = [
    "Confident, not hedgy. Say the thing directly",
    "The first ~40 characters are what a scrolling reader actually sees",
    "never invent a plausible-sounding statistic",
    "No competitor names, ever, even neutrally",
  ];

  it("sanity check: the markers really do appear in the prompt file (so the negative check below is meaningful)", () => {
    const promptContent = readFileSync(path.join(PROMPTS_ROOT, "x-craft", "5.md"), "utf8");
    for (const marker of CRAFT_CONTENT_MARKERS) {
      expect(promptContent.includes(marker), `expected "${marker}" to actually be in x-craft/1.md`).toBe(true);
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

  it("XDraftAgent's config carries a skillRef, not an inline system prompt field", () => {
    const configSource = readFileSync(path.join(SRC_ROOT, "agent", "x-draft-agent.ts"), "utf8");
    expect(configSource).toMatch(/skillRef:\s*"x-craft@5"/);
  });
});
