import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import type { AgentToolRegistry } from "@agent-engine/core";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { validateRenderInputs, type RenderCarouselInput, type RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import type { BrandTokens, ImageCandidate, ImageVettingOutput, InstagramCopyOutput, ResearchFact, ResearchOutput, StyleConfig, VisualQaOutput } from "../src/workflow/types.js";
import { DEFAULT_CAROUSEL_LANE } from "../src/workflow/create-instagram-agent-workflow.js";

export { DEFAULT_CAROUSEL_LANE };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
export const FIXTURES_ROOT = path.join(HERE, "fixtures");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A router whose `.complete()` replays a fixed sequence of turns in order (mirrors `linkedin-agent`'s test helper exactly). */
export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

export function finalTurn(
  output: unknown,
  opts: { model?: string; inputTokens?: number; outputTokens?: number } = {},
): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// A Chromium-free stand-in for `publish.renderCarousel`, used by this
// package's own workflow-level tests (`workflow-e2e.test.ts`,
// `resume-idempotency.test.ts`) — matching `packages/tools/karos-publish`'s
// own package tests' explicit, documented choice to keep actually launching
// Chromium out of unit tests ("that's an integration/e2e concern",
// `render-carousel.test.ts`'s own header comment). It reuses the REAL,
// exported `validateRenderInputs` for every path-guard / missing-file check
// (so a genuine bug in this workflow's `assembleSlidesData` still fails
// these tests exactly as it would in production) and only fakes the final
// "launch Chromium and screenshot" step, writing a tiny real PNG file per
// slide instead so downstream file-existence/count assertions stay
// meaningful. The real, Chromium-backed tool is still exercised directly —
// Chromium-free failure paths in `render-outcome-mapping.test.ts`, and a
// real end-to-end render in `workflow-e2e.test.ts`'s Chromium-gated test
// below when a real browser binary happens to be installed.
// ─────────────────────────────────────────────────────────────────────────

const MINIMAL_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function fakeRenderCarousel(realTool: AgentToolRegistry[string]): AgentToolRegistry[string] {
  return {
    ...realTool,
    async execute(rawArgs: unknown) {
      const parsed = realTool.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { status: "tooling_error", reason: `bad args: ${parsed.error.message}` };
      }
      const input = parsed.data as RenderCarouselInput;
      const validation = await validateRenderInputs(input);
      if (!validation.ok) {
        return validation.kind === "tooling" ? { status: "tooling_error", reason: validation.reason } : { status: "content_fail", reason: validation.reason };
      }
      await fs.mkdir(validation.resolvedOutDir, { recursive: true });
      const rendered: RenderCarouselResult["rendered"] = [];
      for (const slide of input.slides) {
        const outPath = path.join(validation.resolvedOutDir, `slide-${slide.n}.png`);
        await fs.writeFile(outPath, MINIMAL_PNG_BYTES);
        rendered.push({ n: slide.n, path: outPath });
      }
      return { status: "success", result: { rendered } };
    },
  } as AgentToolRegistry[string];
}

/** True when a real Chromium binary is actually installed for Playwright in this environment (checked via its own default cache directory layout, no `playwright` API import needed). Gates the one genuinely-real, Chromium-backed end-to-end test so `npm run test` never flakes on an environment where the browser binary hasn't been downloaded (RFC-03 §5's own documented "known gap"). */
export function isChromiumInstalled(): boolean {
  const cacheDir =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));

  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith("chromium-")) continue;
      const exePath =
        process.platform === "win32"
          ? path.join(cacheDir, entry, "chrome-win", "chrome.exe")
          : process.platform === "darwin"
            ? path.join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
            : path.join(cacheDir, entry, "chrome-linux", "chrome");
      if (existsSync(exePath)) return true;
    }
  } catch {
    // cache dir doesn't exist yet -- Chromium was never installed.
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Fixture builders — a valid style config / brand tokens / image pool a
// happy-path test starts from, with `overrides` for the specific field a
// given test wants to break.
// ─────────────────────────────────────────────────────────────────────────

export function goodStyleConfig(overrides: Partial<StyleConfig> = {}): StyleConfig {
  return {
    style_config_version: 1,
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 },
    rules: [{ id: "no-hype-words", check: "copy", description: "slide copy must not use hype/banned words" }],
    banned_words: ["guaranteed", "the best"],
    banned_chars: [],
    compliance: { regulated: false, required_framing: [], never_say: [] },
    ...overrides,
  };
}

export function goodBrandTokens(overrides: Partial<BrandTokens> = {}): BrandTokens {
  return {
    templateDir: "fixtures/templates",
    slideTemplate: "slide.html",
    ...overrides,
  };
}

/** Enough candidates to cover an 8-slide post — tests that want an unfillable slide pass a smaller/mismatched pool instead. */
export function goodImageCandidatePool(): ImageCandidate[] {
  return [
    { path: "fixtures/images/photo-1.png", description: "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime, no visible branding" },
    { path: "fixtures/images/photo-2.png", description: "a close-up of hands typing on a laptop keyboard at a clean desk" },
    { path: "fixtures/images/photo-3.png", description: "a small team gathered around a table reviewing printed charts" },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// A canonical happy-path scenario: six sourced facts, six slides each
// tracing to one of them verbatim, and six clean image selections. Tests
// that want to break one thing (a banned word, an unfillable slide, a
// dangling sourceRef) start from these and mutate a copy.
// ─────────────────────────────────────────────────────────────────────────

export const SIX_RESEARCH_FACTS: ResearchFact[] = [
  { claim: "Teams that automated their weekly reporting saved an average of 4 hours per week.", source: "internal client survey", date: "2026-07-01" },
  { claim: "Our support team resolved 30% more tickets after switching to the new triage flow.", source: "support dashboard export", date: "2026-07-05" },
  { claim: "Clients who onboarded with the new checklist reached first value 2 days faster.", source: "onboarding cohort analysis", date: "2026-07-10" },
  { claim: "Internal surveys showed a 25% jump in team satisfaction after the process change.", source: "internal pulse survey", date: "2026-07-12" },
  { claim: "The design team cut revision cycles from 5 rounds to 2 on average.", source: "design ops retro notes", date: "2026-07-15" },
  { claim: "Onboarding time dropped from 14 days to 7 days after the rollout.", source: "onboarding cohort analysis", date: "2026-07-18" },
];

export function goodResearchOutput(topic = "process changes that actually moved the needle this quarter"): ResearchOutput {
  return { topic, facts: SIX_RESEARCH_FACTS, rawPayloadRef: "research-run-fixture" };
}

const GOOD_VISUAL_NEEDS = [
  "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime",
  "a close-up of hands typing on a laptop keyboard at a clean desk",
  "a small team gathered around a table reviewing printed charts",
  "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime",
  "a close-up of hands typing on a laptop keyboard at a clean desk",
  "a small team gathered around a table reviewing printed charts",
];

/** Six clean slides, one per `SIX_RESEARCH_FACTS` entry, each `sourceRef` matching a fact's `claim` verbatim. */
export function goodCopyOutput(): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "A quick look at the process changes that actually moved the needle this quarter, and what teams did differently.",
    slides: SIX_RESEARCH_FACTS.map((fact, i) => ({
      n: i + 1,
      headline: `Finding #${i + 1}`,
      body: fact.claim,
      visualNeed: GOOD_VISUAL_NEEDS[i]!,
      sourceRef: fact.claim,
      layout: "photo" as const,
    })),
  };
}

/** Vets every slide in `goodCopyOutput()` against a real fixture image — never a `null`, always rights-usable/watermark-free (Fix 4). */
export function goodImageVettingOutput(pool: ImageCandidate[] = goodImageCandidatePool()): ImageVettingOutput {
  return {
    selections: goodCopyOutput().slides.map((slide, i) => ({
      n: slide.n,
      imagePath: pool[i % pool.length]!.path,
      reason: `candidate matches "${slide.visualNeed}" closely enough`,
      license: "CC0, test fixture",
      rightsUsable: true,
      watermarkFree: true,
    })),
  };
}

/** A clean, passing post-render visual QA verdict (Fix 2) — no `check: "render"` rule findings tripped. */
export function goodVisualQaOutput(): VisualQaOutput {
  return { pass: true, findings: [] };
}

export interface TestEnvironment {
  /** The `WorkspaceStore`'s root — client config/topics catalog/ledger live under here. */
  rootDir: string;
  /** A separate temp directory containing a copy of `__tests__/fixtures/` — passed as `options.repoRoot` so `publish.renderCarousel` has real template/image files to resolve against without ever writing test output into the tracked source tree. */
  repoRoot: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

export async function setupTestEnvironment(
  opts: {
    withConfig?: boolean;
    styleConfig?: StyleConfig;
    brandTokens?: BrandTokens;
    seedTopics?: string[];
    /**
     * Fix 1's lane-scoped tests need more than one lane seeded at once (e.g.
     * one lane sitting at the floor of 5 while another is healthy) — this
     * seeds additional lanes on top of (or instead of) `seedTopics`, which
     * always lands in `DEFAULT_CAROUSEL_LANE` (the workflow's own fallback
     * lane, matched here on purpose — see that constant's doc comment).
     */
    seedTopicsByLane?: Record<string, string[]>;
  } = {},
): Promise<TestEnvironment> {
  const withConfig = opts.withConfig ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-agent-workspace-"));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-agent-repo-"));
  await fs.cp(FIXTURES_ROOT, path.join(repoRoot, "fixtures"), { recursive: true });

  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  if (withConfig) {
    await store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: opts.styleConfig ?? goodStyleConfig(),
      instagramBrandTokens: opts.brandTokens ?? goodBrandTokens(),
    });
  }

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  const seedTopics = opts.seedTopics ?? [
    "5 automation wins from this quarter",
    "how our team cut onboarding time in half",
    "a behind-the-scenes look at our design process",
    "customer story: scaling from 10 to 100 clients",
    "the tool stack we switched to this year",
    "lessons from our biggest product launch",
  ];
  // Seeded under the workflow's own default lane (`DEFAULT_CAROUSEL_LANE`) so
  // step 03's `topics.reserve` call (which always passes a lane, real or
  // default — Fix 1) finds these rows without a client ever having to set
  // `requestedLane` explicitly in these tests.
  await tools["topics.topUp"]!.execute({ topics: seedTopics, lane: DEFAULT_CAROUSEL_LANE }, { ctx: seedCtx });

  for (const [lane, topics] of Object.entries(opts.seedTopicsByLane ?? {})) {
    await tools["topics.topUp"]!.execute({ topics, lane }, { ctx: seedCtx });
  }

  return {
    rootDir,
    repoRoot,
    store,
    tools,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
      await fs.rm(repoRoot, { recursive: true, force: true });
    },
  };
}
