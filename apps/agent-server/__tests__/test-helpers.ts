import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, ModelRouter } from "@agent-engine/core";
import { InMemoryPromptStore } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { MemoryDurableStepStore } from "@agent-engine/workflow";
import type { AgentRuntimeDeps } from "../src/wiring/workflows.js";
import { randomUUID } from "node:crypto";
import { startRunJob, type RunJobRequest } from "../src/run-job.js";

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  runtimeDeps: AgentRuntimeDeps;
  durableStore: MemoryDurableStepStore;
  cleanup: () => Promise<void>;
}

/**
 * A `ModelRouter` that serves every agent in the fan-out from one shared
 * instance (matching `buildWorkflowForProduct`'s real production wiring,
 * where every channel and the campaign strategy step share `deps.router`)
 * by matching the requested `schema` against a pool of candidate outputs,
 * rather than a strict call-order queue — the campaign orchestrator's
 * 5-channel fan-out runs concurrently, so which channel's `router.complete()`
 * actually lands first is not deterministic; matching by schema is.
 */
export function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        // BaseAgent's turnSchema is a discriminated union of {type:"tool_call",...}
        // | {type:"final", output: <the agent's own outputSchema>} — never the raw
        // draft directly (see packages/core/src/agent/base-agent.ts's runOneTurn) —
        // so the candidate has to be validated wrapped, exactly like every other
        // fakeRouterSequence/finalTurn helper across this codebase already does.
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }
      }
      throw new Error("smartFakeRouter: no candidate output matches the requested schema");
    },
    async completeAlias() {
      throw new Error("smartFakeRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

export function goodXDraft() {
  // No numeric claim: production `sources` is always [] (research.pull is a
  // Phase-1 stand-in) and gate.numbersSourced now verifies the exact figure
  // against real source content, not just a citation marker.
  const mainPostText = "More teams are testing 4-day weeks this quarter. Early internal data shows steady output with fewer sick days.";
  return {
    text: mainPostText,
    mainPostText,
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "data-point",
    lane: "knowledge",
    targetHandle: "@acmecorp",
    mediaRefs: [],
  };
}

export function goodLinkedInDraft() {
  const hook = "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.";
  const body = "Teams with a fixed two-day in-office schedule reported fewer scheduling conflicts than teams with fully flexible policies.";
  const callToAction = "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.";
  // linkedin-craft@5 (2026-09): `takeaway` is required and expected in `text`.
  const takeaway = "Predictability, not enforcement, is what made the schedule stick.";
  return {
    headline: "Anchor days cut scheduling friction",
    hook,
    body,
    takeaway,
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction,
    targetAudience: "People leaders evaluating hybrid work policies",
    text: `${hook}\n\n${body}\n\n${takeaway}\n\n${callToAction}`,
    archetype: "industry-reaction",
  };
}

/** Reddit's reply-only schema (Phase 2.5 Batch 2.1): replies to an existing thread, never an original submission. */
export function goodRedditDraft() {
  const targetThreadTitle = "Our team switched to a 4-day week 3 months ago: sharing what actually changed";
  const replyBody =
    "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
    "Internal tracking showed a real drop in reported sick days across the team.\n\n" +
    "Happy to share more detail if it's useful for your own trial.";
  return {
    targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/our_team_switched_to_a_4day_week/",
    targetThreadTitle,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

export function goodBlogDraft() {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  // 600+ words -- the blog channel's own gate enforces a minimum-length floor
  // (RFC-02 §5 migration audit remediation); a stub-length fixture here would hold.
  const bodyMarkdown =
    "## The problem with our old onboarding\n\n" +
    "New engineers took nearly a month before they shipped anything meaningful, and that gap was never caused by a shortage of " +
    "ability. Most new hires spent the bulk of their first three weeks trying to figure out who owned a given service, which " +
    "document was current and which had been abandoned two reorganizations ago, and where the actual source of truth lived for a " +
    "system that touched their work. The technical material itself was rarely the real blocker. A capable engineer could read the " +
    "codebase just fine; what slowed everyone down was the absence of a predictable path through that first week, so every cohort " +
    "effectively reinvented onboarding from scratch and asked the same scattered questions that had already been answered for " +
    "someone else three months earlier.\n\n" +
    "## What we actually changed\n\n" +
    "We restructured the first week into four fixed days, each with one specific and narrow goal instead of a loose list of things " +
    "a new hire should eventually get around to. Day one was environment setup end to end: local build, full test suite, and a " +
    "single deploy to a sandbox environment, so that by the end of day one every new engineer had concrete proof their machine " +
    "actually worked. Day two paired the new hire with an engineer who walked through the two or three systems most relevant to " +
    "their team, focused on how the pieces connect to each other rather than reading every file line by line. Day three handed the " +
    "new hire a small, genuinely scoped ticket chosen in advance by their manager, so nobody spent the morning hunting for something " +
    "appropriate to work on. Day four closed the week with a short review session involving the whole team, where the new hire " +
    "walked through what they built and asked the questions that had piled up over the previous three days.\n\n" +
    "## The results after one quarter\n\n" +
    "Median time to first merged pull request dropped sharply, from about 19 days down to about 10. Just as important, the variance between " +
    "individual engineers narrowed sharply: under the old approach some new hires needed six weeks before their first real " +
    "contribution while others needed nine days, and that spread alone made it hard to plan work around new team members with any " +
    "real confidence. Retention at the ninety-day mark also held steady across the cohort, which mattered to us as much as raw " +
    "speed did, since a faster ramp that came at the cost of early attrition would not have counted as a genuine win.\n\n" +
    "## What we'd do differently\n\n" +
    "The biggest gap in our first run was documentation for the paired-engineer session on day two: two different pairs ran that " +
    "session in noticeably different ways, and new hires noticed the inconsistency immediately once they compared notes with each " +
    "other. If your team decides to try something similar, write the walkthrough script down before your first cohort goes through " +
    "it, not after you have already seen where it went sideways. We also underestimated how much day three depended on managers " +
    "actually preparing a ticket in advance; the one week where a manager scrambled to find a ticket the morning of day three was " +
    "the one week where the whole schedule slipped. If your team is rethinking its own onboarding, a structured first week is worth " +
    "testing before you assume the underlying problem is your documentation, your codebase, or your new hires themselves.\n\n" +
    "## One more thing worth naming\n\n" +
    "It is tempting to treat a rollout like this as finished once the first cohort clears it successfully, but the real test comes " +
    "with the second and third cohorts, run by people who were not in the room when the plan was designed. Write the reasoning down " +
    "alongside the schedule itself, not just the steps: explain why day one is environment setup and not a lecture on architecture, " +
    "why the ticket on day three has to be scoped small enough to finish in a single day, and why the whole plan tops out at four " +
    "days instead of stretching to a full two weeks. A team that only inherits the checklist tends to drift from it the first time " +
    "a deadline gets tight, while a team that inherits the reasoning behind the checklist is far more likely to adapt it sensibly " +
    "instead of quietly abandoning it.";
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle for our engineering team.",
    bodyMarkdown,
    headersList: ["The problem with our old onboarding", "What we actually changed", "The results after one quarter", "What we'd do differently"],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 5,
    text: `${title}\n\n${bodyMarkdown}`,
    faqItems: [],
  };
}

export function goodNewsletterDraft() {
  const intro = "This week we're looking at what's actually working for engineering teams right now.";
  const sections = [
    { heading: "Structured onboarding cuts ramp time", body: "New-hire ramp time dropped sharply after a fixed four-day onboarding rollout." },
  ];
  const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
  const signoff = "The Acme Weekly Team";
  const text = `${intro}\n\n${sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n")}\n\n${callToAction.text}\n\n${signoff}`;
  return { subjectLine: "3 teams cut onboarding time in half", previewText: "Plus: async standups are quietly replacing daily syncs.", intro, sections, callToAction, signoff, text };
}

export function goodCampaignPlan() {
  return {
    campaignName: "Q3 Structured Onboarding Launch",
    theme: "Structured processes deliver measurable team performance gains",
    targetPillars: ["engineering culture", "team operations", "product-led growth"],
    channelSlots: [
      { slotId: "launch-x", channel: "x", targetAudience: "engineering leaders scrolling X for a quick, sharp data point", angle: "data-point", keyMessage: "Structured 4-day onboarding cut new-hire ramp time by 47%" },
      { slotId: "launch-linkedin", channel: "linkedin", targetAudience: "B2B SaaS engineering managers and VPs browsing LinkedIn", angle: "thought-leadership", keyMessage: "Predictable onboarding structure builds team trust faster than flexibility alone" },
      { slotId: "launch-reddit", channel: "reddit", targetAudience: "r/ExperiencedDevs and r/EngineeringManagement readers who distrust marketing posts", angle: "value-add-discussion", keyMessage: "Here's exactly what we changed about onboarding and what happened afterward" },
      { slotId: "launch-blog", channel: "blog", targetAudience: "technical readers researching onboarding practices in depth", angle: "conceptual-guide", keyMessage: "A full breakdown of the four-day onboarding structure and its measured results" },
      { slotId: "launch-newsletter", channel: "newsletter", targetAudience: "newsletter subscribers who want a curated weekly digest, not a sales pitch", angle: "curated-digest", keyMessage: "This week's roundup leads with our onboarding case study alongside two related team-ops stories" },
    ],
  };
}

/** All six agents' craft prompts, seeded with short placeholder content — this is a server-wiring test, not a prompt-resolution test, so the real markdown files' exact text doesn't matter, only that every promptId the six workflows resolve is registered. */
export function makeSharedPromptStore(): InMemoryPromptStore {
  const store = new InMemoryPromptStore();
  // Every numbered version any agent here has ever pinned to is registered,
  // so this wiring test doesn't care which one a given agent's pinned
  // skillRef resolves -- x-craft/linkedin-craft/reddit-craft bumped to @2 in
  // Phase 2.5 (lane restoration / archetype restoration / reply-only model),
  // then all five bumped again (x/linkedin/reddit to @3, blog/newsletter to
  // @2) for the client-language check added against `clientVoiceContext`.
  store.setPrompt("x-craft", "1", "X craft guidance.");
  store.setPrompt("x-craft", "2", "X craft guidance.");
  store.setPrompt("x-craft", "3", "X craft guidance.");
  store.setPrompt("x-craft", "4", "X craft guidance.");
  store.setPrompt("x-craft", "5", "X craft guidance.");
  store.setPrompt("linkedin-craft", "1", "LinkedIn craft guidance.");
  store.setPrompt("linkedin-craft", "2", "LinkedIn craft guidance.");
  store.setPrompt("linkedin-craft", "3", "LinkedIn craft guidance.");
  store.setPrompt("linkedin-craft", "4", "LinkedIn craft guidance.");
  store.setPrompt("linkedin-craft", "5", "LinkedIn craft guidance.");
  store.setPrompt("reddit-craft", "1", "Reddit craft guidance.");
  store.setPrompt("reddit-craft", "2", "Reddit craft guidance.");
  store.setPrompt("reddit-craft", "3", "Reddit craft guidance.");
  store.setPrompt("reddit-craft", "4", "Reddit craft guidance.");
  store.setPrompt("reddit-craft", "5", "Reddit craft guidance.");
  // reddit-agent's two judgment steps (auto-setup planner, thread scout).
  store.setPrompt("reddit-channel-plan", "1", "Reddit channel planning guidance.");
  store.setPrompt("reddit-scout", "1", "Reddit thread scouting guidance.");
  store.setPrompt("blog-craft", "1", "Blog craft guidance.");
  store.setPrompt("blog-craft", "2", "Blog craft guidance.");
  store.setPrompt("blog-craft", "3", "Blog craft guidance.");
  store.setPrompt("newsletter-craft", "1", "Newsletter craft guidance.");
  store.setPrompt("newsletter-craft", "2", "Newsletter craft guidance.");
  store.setPrompt("newsletter-craft", "3", "Newsletter craft guidance.");
  store.setPrompt("newsletter-craft", "4", "Newsletter craft guidance.");
  store.setPrompt("newsletter-craft", "5", "Newsletter craft guidance.");
  store.setPrompt("campaign-craft", "1", "Campaign strategy guidance.");
  return store;
}

const BASE_CTX_FIELDS = { productId: "agent-server-test", runKind: "recurring" as const };

/** Seeds one tenant with everything every one of the six workflows' own intake checks needs, under a shared WorkspaceStore. */
export async function setupTestEnvironment(clientSlug = "acme"): Promise<TestEnvironment> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` passed explicitly: `research.pull` reports
  // not_available without a real scraper rather than returning a placeholder
  // (see karos-research/src/pull.ts). Tests still need deterministic offline
  // data, so they opt in; nothing in `apps/src` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  const seedCtx: AgentContext = { runId: "seed", clientSlug, ...BASE_CTX_FIELDS, metadata: {} };
  await store.writeJson(clientSlug, ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson(clientSlug, ["client", "voice-rules"], { tone: "confident, no jargon" });
  await store.writeJson(clientSlug, ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  await store.writeJson(clientSlug, ["client", "config"], {
    xHandle: "@acmecorp",
    targetSubreddits: ["smallbusiness", "startups"],
    // Reddit's reply-only model (Phase 2.5 Batch 2.1) has no live thread-discovery
    // backend yet -- a run needs an explicit target thread supplied via intake.
    requestedThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/our_team_switched_to_a_4day_week/",
    requestedThreadTitle: "Our team switched to a 4-day week 3 months ago: sharing what actually changed",
    targetKeywords: ["engineering onboarding", "developer ramp-up time"],
    contentPillars: ["engineering culture", "team operations"],
    targetAudience: "engineering leaders at mid-size B2B SaaS companies",
    frequency: "weekly",
    campaignGoals: "Launch awareness for the new structured-onboarding product feature across every channel this quarter.",
  });
  await tools["topics.topUp"]!.execute(
    {
      topics: [
        "structured engineering onboarding",
        "async standups",
        "on-call rotations",
        "code review culture",
        "remote hiring",
        "four-day work weeks",
        "hybrid work anchor days",
        "engineering team retention",
        "developer productivity metrics",
        "technical debt triage",
        "incident response culture",
        "manager 1:1 cadence",
      ],
    },
    { ctx: seedCtx },
  );

  const durableStore = new MemoryDurableStepStore();
  const promptStore = makeSharedPromptStore();
  const router = smartFakeRouter([
    goodCampaignPlan(),
    goodXDraft(),
    goodLinkedInDraft(),
    goodRedditDraft(),
    goodBlogDraft(),
    goodNewsletterDraft(),
  ]);

  return {
    rootDir,
    store,
    durableStore,
    // The SAME store `tools` was built over (SCRUM-328): the server's composition
    // roots thread one instance through both, and so must the test environment.
    // A fetch that answers 404 to everything: reddit-agent's thread read
    // degrades to title-only instead of reaching reddit.com from a test.
    runtimeDeps: { tools, promptStore, router, workspaceStore: store, publicFetch: async () => new Response("not found", { status: 404 }) },
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

/**
 * An `enqueueRunJob` that runs the job in-process (AU66 / SCRUM-364).
 *
 * `/runs/start` enqueues now; it does not execute. These tests are about the
 * ROUTE and the workflows behind it, not about Pub/Sub, and they run on
 * machines with no GCP — so they supply their own meaning for "enqueue",
 * exactly as `scripts/smoke-test-server.ts` does.
 *
 * The point worth keeping: the route's contract is identical either way. It
 * hands the job off and returns 202. Nothing here re-synchronises the route,
 * which is what would have quietly preserved the trap for everyone else.
 */
export function inProcessEnqueue(env: TestEnvironment): (request: RunJobRequest) => Promise<{ runId: string }> {
  return async (request) => {
    const runId = `test-${randomUUID()}`;
    await startRunJob(request, runId, { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
    return { runId };
  };
}
