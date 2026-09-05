import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { runLinkedInChannelSetup, type ChannelSetupOutcome } from "@agent-engine/agent-setup";
import {
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  runTopicGuardrail,
  extractResearchCandidate,
  researchDigestForDrafting,
  researchSourceTexts,
  readRunDirection,
  runDirectionField,
  type RevisionNote,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
  buildClientVoiceContext,
  readOutputHistoryForDedup,
  dedupeDirective,
  checkOutputDedupe,
  dedupeRetryDirective,
  readClientIntelContext,
  toAgentContext,
  runGate,
  finalizeDeliverable,
  recordOutputExcerpt,
  buildTrendQueries,
  pullTrendResearch,
  runTrendScout,
  researchDigestForScout,
  selectContentMode,
  selectTrendCandidate,
  trendCandidateForDrafting,
  parseContentModeFromSummary,
  analyzeAttachedMedia,
  attachedMediaForDrafting,
  resolveSocialMedia,
  mediaForDeliverable,
  type ContentMode,
  type SocialMediaPlan,
  type TrendResearch,
  type TrendScoutOutput,
} from "@agent-engine/workflow";
import { LinkedInDraftAgent, type LinkedInPostOutput } from "../agent/linkedin-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderLinkedInDraftsMarkdown } from "./render-drafts-markdown.js";
import { checkLinkedInFormatting, reflowLinkedInText, type LinkedInFormattingReport } from "./linkedin-format.js";
import {
  ARCHETYPES_FOR_MODE,
  LINKEDIN_ARCHETYPES,
  type LinkedInAgentWorkflowResult,
  type LinkedInArchetype,
  type LinkedInArchetypeSelection,
  type LinkedInCandidateSummary,
  type LinkedInClientContext,
  type LinkedInContentModeSelection,
  type LinkedInDecisionsShelf,
  type LinkedInIdentity,
  type LinkedInIdentityScope,
  type LinkedInIntakeConfig,
  type LinkedInSelectedCandidate,
  type LinkedInTopicReservation,
} from "./types.js";
import type { Executive } from "@agent-engine/tools";

export interface CreateLinkedInAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 15's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3). Intended for tests/demos/evals that need a synchronous happy
   * path, never for production wiring.
   */
  autoApprove?: boolean;
  /**
   * Which posting identity this workflow drafts as when a given run's
   * `client.getConfig` doesn't request one itself (legacy "two-paths"
   * design — company/brand voice vs. a named executive's own voice).
   * Defaults to `"company"`, matching every pre-existing caller's behavior
   * exactly. A per-run `requestedIdentityScope` in client config always
   * takes precedence over this workflow-level default.
   */
  identityScope?: LinkedInIdentityScope;
  /**
   * Bounds root for the media cache (2026-09). Every sourced or attached image
   * lands under `<repoRoot>/.media-cache/<runId>/`. Optional: without it the
   * post ships as text and the media step records why.
   */
  repoRoot?: string | undefined;
}

/**
 * How many drafting passes the verified de-duplication check may cost —
 * initial draft plus two redraft steers, the same budget instagram-agent's
 * `MAX_SELF_CHECK_ATTEMPTS` gives its own 07d dedupe check. On the last
 * attempt a `similar` draft ships FLAGGED (the verdict stays checkpointed for
 * the trace and the reviewer), never held: `evaluateDedupe`'s own policy is
 * that de-duplication flags and steers, it does not hold a run.
 */
const MAX_DEDUPE_ATTEMPTS = 3;

/** The draft plus the media and formatting report the run produced for it — what the review gate shows and the deliverable persists. */
type LinkedInDraftWithMedia = LinkedInPostOutput & { mediaPlan: SocialMediaPlan; formatting: LinkedInFormattingReport };

/** A valid archetype name, or `undefined` if the string isn't one of `LINKEDIN_ARCHETYPES`. */
function parseArchetype(value: unknown): LinkedInArchetype | undefined {
  return typeof value === "string" && (LINKEDIN_ARCHETYPES as readonly string[]).includes(value) ? (value as LinkedInArchetype) : undefined;
}

/** Pulls a decision summary's recorded archetype back out (written as `(archetype: <name>)` by step 18) — the mechanism the "never the same lane as last post" rule (`lanes.md` §2) actually checks against. */
function extractArchetypeFromSummary(summary: string): LinkedInArchetype | undefined {
  const match = /archetype:\s*([a-z-]+)/i.exec(summary);
  return match ? parseArchetype(match[1]!.toLowerCase()) : undefined;
}

/**
 * This run's own request layered over the client's standing configuration.
 *
 * `lanes.md`: "the customer's run request wins". Before the engine could
 * carry a per-run input, the only way to express one was to write it into
 * client config -- which every other run for that client then inherited.
 *
 * Only run-scoped keys are overlaid. Client identity (executives, handles) is
 * not a per-run choice, and letting a job payload rewrite it would be a
 * tenancy hole rather than a feature.
 */
const RUN_SCOPED_KEYS = ["requestedTopic", "requestedArchetype", "requestedIdentityScope", "requestedExecutiveName", "requestedMode"] as const;

function withRunInput(config: unknown, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const base = (config ?? {}) as Record<string, unknown>;
  const overlay: Record<string, unknown> = {};
  for (const key of RUN_SCOPED_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) overlay[key] = value.trim();
  }
  return { ...base, ...overlay };
}

function readRunConfig(config: unknown): {
  requestedIdentityScope?: LinkedInIdentityScope;
  requestedExecutiveName?: string;
  requestedArchetype?: LinkedInArchetype;
  requestedMode?: string;
} {
  const record = config as {
    requestedIdentityScope?: LinkedInIdentityScope;
    requestedExecutiveName?: string;
    requestedArchetype?: string;
    requestedMode?: string;
  };
  const requestedArchetype = parseArchetype(record.requestedArchetype);
  return {
    ...(record.requestedIdentityScope !== undefined ? { requestedIdentityScope: record.requestedIdentityScope } : {}),
    ...(record.requestedExecutiveName !== undefined ? { requestedExecutiveName: record.requestedExecutiveName } : {}),
    ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
    ...(typeof record.requestedMode === "string" ? { requestedMode: record.requestedMode } : {}),
  };
}

function readStringList(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return items.length > 0 ? items : undefined;
}

/** The art direction the generative fallback receives, from the client's brand record. Nothing is invented: absent fields stay absent. */
function artDirectionFromBrand(brand: Record<string, unknown>): { aesthetic?: string; lighting?: string; palette?: string[]; accentColor?: string; mood?: string } | undefined {
  const pick = (key: string) => (typeof brand[key] === "string" && (brand[key] as string).trim().length > 0 ? (brand[key] as string).trim() : undefined);
  const palette = readStringList(brand, "palette");
  const art = {
    ...(pick("aesthetic") ? { aesthetic: pick("aesthetic")! } : {}),
    ...(pick("lighting") ? { lighting: pick("lighting")! } : {}),
    ...(palette ? { palette: palette.slice(0, 6) } : {}),
    ...(pick("accent") ? { accentColor: pick("accent")! } : {}),
    ...(pick("visualMood") ? { mood: pick("visualMood")! } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}

/** Picks the executive to post as: an explicit per-run name match (case-insensitive) wins, else the first configured executive. */
function selectExecutive(executives: Executive[], requestedExecutiveName?: string): Executive {
  if (requestedExecutiveName) {
    const match = executives.find((e) => e.name.toLowerCase() === requestedExecutiveName.toLowerCase());
    if (match) return match;
  }
  return executives[0]!;
}

/**
 * The restored default archetype rotation (Phase 2.5 Batch 2.2), ordered
 * highest-priority-first per `linkedin-voice-by-industry.md`'s suggested mix
 * (framework/teardown heaviest, then lesson/industry-react, tapering to the
 * rarer milestone/contrarian/vulnerability slots) — two orderings, one
 * biased toward archetypes that read well with a genuine numeric finding in
 * hand, one for when there isn't one. Selection always walks the ordering
 * and skips whichever archetype the immediately-prior run used (`lanes.md`
 * §2's "never the same lane as this identity's last post" rule) — the one
 * rule the spec says "does most of the work."
 */
const DEFAULT_ARCHETYPE_ORDER: readonly LinkedInArchetype[] = [
  "teardown-framework",
  "lesson-learned",
  "industry-reaction",
  "build-in-public",
  "community-question",
  "contrarian-take",
  "customer-story",
  "origin-story",
  "milestone-launch",
  "hiring-culture",
  "vulnerability-admission",
];

const NUMERIC_INSIGHT_ARCHETYPE_ORDER: readonly LinkedInArchetype[] = [
  "milestone-launch",
  "teardown-framework",
  "customer-story",
  "build-in-public",
  "industry-reaction",
  "contrarian-take",
  "lesson-learned",
  "community-question",
  "origin-story",
  "hiring-culture",
  "vulnerability-admission",
];

/**
 * "Daniel Herbert" -> "daniel-herbert", matching the lab repo's own
 * `seat-intake/<name>.md` filenames, which is what the migrated documents are
 * keyed by. Kept beside the caller rather than in a shared util because it
 * encodes that one naming convention and nothing else depends on it.
 */
function slugifySeat(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `createLinkedInAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X pilot
 * in §3): the recurring/on-demand run protocol, steps `00`–`18`. One post,
 * one run (RFC-01 §16.2's ruling) — no fan-out here; every LinkedIn run
 * produces at most one deliverable. Step 15 is a mandatory human
 * `batch_review` gate (RFC-01 §8.3) unless `options.autoApprove` opts out.
 *
 * ## The 2026-09 elite-tier upgrade, in the order a run meets it
 *
 * - **04**: research is several questions (industry news, launches/deals/
 *   reports, the client's own name, the client's configured `trendQueries`),
 *   merged and de-duplicated.
 * - **07a**: when nobody planned this run's subject, a trend SCOUT (Gemini
 *   Flash) turns the research into brand-fit-scored candidates tagged by
 *   content mode; the strongest on-brand one takes the slot.
 * - **07b**: the content-mode rotation — hot news / deep value / open
 *   discussion — never the same twice, steering which archetype family 08
 *   draws from.
 * - **08b**: media the client ATTACHED is read by a vision model BEFORE
 *   drafting, so the post is written to the picture.
 * - **09**: the draft receives the research itself, the trend candidate,
 *   the mode and the attached media — until now it received a headline.
 * - **09b**: the post is re-flowed into LinkedIn's shape (one or two
 *   sentences per line, a blank line between) without touching a word, and
 *   the takeaway's presence is checked; findings are notes for the
 *   reviewer, never a hold.
 * - **10**: the numbers gate verifies against source TEXT, not a URL.
 * - **14b**: the media resolver answers the draft's own `mediaBrief`
 *   (screenshot, article image, stock, generation last, vision-judged).
 */
export function createLinkedInAgentWorkflow(options: CreateLinkedInAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function linkedInAgentWorkflow(wf: WorkflowContext): Promise<LinkedInAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

    /*
     * ── 00-channel-setup: a pre-flight this agent runs for itself ──
     *
     * `linkedin-setup-agent` used to be a separate product in the catalog, and
     * the sequencing was left to whoever ran it: notice this client has no
     * charter, find the setup card, run it, come back. Nothing enforced that
     * order and nothing announced it, so a run against an unconfigured client
     * simply drafted with `strategy: null` — a post in nobody's voice, with no
     * "never post about X" list, and no error anywhere.
     *
     * Now the run checks first. A client with a charter pays one read and
     * nothing else; a run carrying a filled form records it here and drafts
     * against it immediately.
     *
     * NOT blocking when neither exists. This agent has always been able to
     * draft without a charter — `01-load-client-context` treats a missing one
     * as `strategy: null` — and turning that into a refusal would take away a
     * capability while claiming to add one. The step records which of the three
     * paths it took, so "drafted without a charter" is visible in the trace
     * rather than inferred from its absence.
     */
    const channelSetup: ChannelSetupOutcome = await wf.step.code("00-channel-setup", () =>
      runLinkedInChannelSetup({ tools, ctx, runId: wf.runId, clientSlug: wf.clientSlug, input: wf.input ?? {} }),
    );

    // ── 00: intake check — blocked_intake if foundation data is missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<LinkedInIntakeConfig> => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      if (profileOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client profile has not been set up yet");
      }
      const voiceRulesOutcome = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      if (voiceRulesOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client has not configured voice rules yet");
      }
      // A client's own per-run config can request the executive identity path
      // (legacy "two-paths" design) — options.identityScope is only the
      // fallback default when the client doesn't ask for one.
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const { requestedIdentityScope, requestedMode } = readRunConfig(withRunInput(config, wf.input));
      const identityScope: LinkedInIdentityScope = requestedIdentityScope ?? options.identityScope ?? "company";
      if (identityScope === "executive") {
        const executivesOutcome = await tools["client.getExecutives"]!.execute({}, { ctx });
        if (executivesOutcome.status !== "success" || (executivesOutcome.result as Executive[]).length === 0) {
          throw new WorkflowBlockedIntake(
            "identityScope is \"executive\" for this run, but the client has no executives configured to post as",
          );
        }
      }
      const trendQueries = readStringList(config, "trendQueries");
      return {
        // Same read that produced identityScope, so the terminal guardrail
        // below costs no extra step.
        forbiddenTopics: configOutcome.status === "success" ? readForbiddenTopics(configOutcome.result) : [],
        profile: profileOutcome.result as Record<string, unknown>,
        voiceRules: voiceRulesOutcome.result as Record<string, unknown>,
        ...(requestedMode !== undefined ? { requestedMode } : {}),
        ...(trendQueries ? { trendQueries } : {}),
        trendJacking: config["trendJacking"] === "always" ? "always" : "fallback",
      };
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<LinkedInClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      // client.getConfig is optional here (unlike the intake check above) — a
      // client may simply not have requested a specific topic (or identity) for this run.
      const config = await tools["client.getConfig"]!.execute({}, { ctx });
      const merged = withRunInput(config.status === "success" ? config.result : {}, wf.input);
      const requestedTopic = (merged as { requestedTopic?: string }).requestedTopic;
      const { requestedIdentityScope, requestedExecutiveName, requestedArchetype } = readRunConfig(merged);
      const identityScope: LinkedInIdentityScope = requestedIdentityScope ?? options.identityScope ?? "company";

      let identity: LinkedInIdentity = { scope: "company" };
      if (identityScope === "executive") {
        const executivesOutcome = await tools["client.getExecutives"]!.execute({}, { ctx });
        if (executivesOutcome.status !== "success" || (executivesOutcome.result as Executive[]).length === 0) {
          // Step 00 already blocks this same condition — reaching here on a
          // resumed/re-run should be unreachable, but never silently fall
          // back to the company voice for an explicitly-requested executive run.
          throw new WorkflowBlockedIntake(
            "identityScope is \"executive\" for this run, but the client has no executives configured to post as",
          );
        }
        const executive = selectExecutive(executivesOutcome.result as Executive[], requestedExecutiveName);
        identity = {
          scope: "executive",
          executiveName: executive.name,
          ...(executive.title !== undefined ? { executiveTitle: executive.title as string } : {}),
          ...(executive.careerHistory !== undefined ? { careerHistory: executive.careerHistory as string } : {}),
          ...(executive.corePillars !== undefined ? { corePillars: executive.corePillars as string[] } : {}),
          ...(executive.offLimitsTopics !== undefined ? { offLimitsTopics: executive.offLimitsTopics as string[] } : {}),
          ...(executive.voiceTone !== undefined ? { voiceTone: executive.voiceTone as string } : {}),
        };
      }

      // The setup document for the identity this run posts as: the seat's own
      // intake for an executive, the company page's standing direction
      // otherwise. Keyed by identity rather than by client so a seat never
      // inherits the company's charter — see LinkedInClientContext.strategy.
      //
      // The tool may be absent from a caller's registry entirely (it is new);
      // that is the same as having no document, not a crash.
      const getStrategy = tools["client.getStrategy"];
      let strategy: string | null = null;
      if (getStrategy) {
        const key = identity.scope === "executive" ? slugifySeat(identity.executiveName) : undefined;
        const outcome = await getStrategy.execute(
          { agent: "linkedin-agent", ...(key ? { key } : {}) },
          { ctx },
        );
        if (outcome.status === "success") {
          strategy = (outcome.result as { markdown: string }).markdown;
        }
      }

      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as LinkedInClientContext["voiceRules"]) : {},
        ...(requestedTopic !== undefined ? { requestedTopic } : {}),
        ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
        identity,
        strategy,
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<LinkedInDecisionsShelf & { modes: ContentMode[] }> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return { summaries: [], modes: [] };
      const result = outcome.result as { scope: string; items: Array<{ summary: string; at?: number }> };
      // `memory.read({scope:"decisions"})` is now product-scoped (AU24 / audit
      // §4.2-§4.3-3): `karos-memory` keys the decision log by `(clientSlug,
      // productId)`, so `result.items` here is already just this LinkedIn
      // product's own history — a same-client `x-agent`/`blog-agent`/etc. post
      // can no longer stand in for "the last LinkedIn post," at any timestamp.
      // The archetype-parsing below still has a real job: a decision row has
      // no first-class `archetype` field, only the free-text `summary` step 18
      // writes it into, so this still has to pull the value back out of that
      // string and filter out any row that doesn't parse one. Sorting by the
      // decision's own `at` (mirroring x-agent's lane.ts) still matters:
      // `listJson` returns entries in filename order, not chronological order.
      const dated = result.items.map((item) => ({ at: item.at ?? 0, summary: item.summary })).sort((a, b) => a.at - b.at);
      const lastArchetype = dated
        .map((item) => extractArchetypeFromSummary(item.summary))
        .filter((a): a is LinkedInArchetype => a !== undefined)
        .at(-1);
      // The content modes, oldest first — the same summary field, `(… mode: X)`.
      const modes = dated.map((item) => parseContentModeFromSummary(item.summary)).filter((m): m is ContentMode => m !== undefined);
      return {
        summaries: result.items.map((item) => item.summary),
        ...(lastArchetype !== undefined ? { lastArchetype } : {}),
        modes,
      };
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    //
    // Several questions, one step (2026-09). `${industry} thought leadership
    // trends this week` alone returned the week's generic think-pieces and no
    // launch, deal or report that had actually happened.
    const industry = (clientContext.profile["industry"] as string | undefined) ?? undefined;
    const companyName = (clientContext.profile["companyName"] as string | undefined) ?? (clientContext.profile["name"] as string | undefined);
    const queries = buildTrendQueries({
      industry,
      companyName,
      configuredQueries: intake.trendQueries,
      requestedTopic: runDirection.topicOverride ?? clientContext.requestedTopic,
    });
    const research: TrendResearch = await pullTrendResearch(wf, tools, ctx, {
      stepId: "04-research-pull",
      job: "linkedin-trend-scan",
      queries: queries.length > 0 ? queries : [`${industry ?? "this industry"} thought leadership trends this week`],
      // LinkedIn content moves slower than X news — a 7-day window vs. X's 24h.
      window: "7d",
      // Anti-repetition context: this agent's own prior deliverables, so
      // the extraction below can steer off a subject already covered.
      historyAgentId: "linkedin-agent",
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): LinkedInCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // Kept as the last-resort fallback behind the scout.
      extractResearchCandidate(research.merged, { avoidTopics: recentDecisions.summaries }),
    );

    // ── 06-08: candidate selection, mode and archetype determination ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<LinkedInTopicReservation> => {
      const excludeTopics = recentDecisions.summaries;
      const outcome = await tools["topics.reserve"]!.execute(
        { reservationKey: `${wf.runId}__topic`, count: 1, excludeTopics },
        { ctx },
      );
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topics: result.topics };
      }
      // content_fail here just means the catalog floor is currently empty — not fatal,
      // step 07's precedence falls through to the scout, then the research-derived candidate.
      return { topics: [] };
    });

    // ── The read side of the feedback flywheel: what this client asked
    //    for on previous runs, injected into the drafting prompt. Bounded
    //    and best-effort — a memory read failing must not stop a run that
    //    can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");
    // The anti-repetition read: what this agent already SHIPPED for this
    // client (the excerpt window the commit step below writes back into),
    // formatted as a hard do-not-repeat directive for the draft. Read before
    // the scout, which must not propose what the client just published.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "linkedin-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    // The client intel report AND knowledge base, distilled to what steers
    // copy — the client knowledge this platform holds, read by the scout and
    // the draft alike.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);

    // ── 07a: the trend scout — only when no one planned this run's subject ──
    //
    // A typed or configured topic is the client's own statement; a catalog
    // row is a planned editorial slot with a dedup lock. Both outrank a trend
    // by default (`trendJacking: "fallback"`), so the scout runs exactly where
    // the old code fell back to "first headline with a number in it".
    const wantsScout = !runDirection.topicOverride && !clientContext.requestedTopic && (reservation.topics.length === 0 || intake.trendJacking === "always");
    let scout: TrendScoutOutput | undefined;
    if (wantsScout) {
      scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "07a-trend-scout", {
        research: researchDigestForScout(research.merged),
        channel: "linkedin",
        clientProfile: clientContext.profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        forbiddenTopics: intake.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
    }

    // ── 07b: the content-mode rotation — never the same twice, least-used first ──
    const modeSelection = await wf.step.code("07b-select-content-mode", (): LinkedInContentModeSelection => {
      const priorMode = recentDecisions.modes.at(-1);
      const mode = selectContentMode(recentDecisions.modes, intake.requestedMode);
      return {
        mode,
        source: intake.requestedMode !== undefined && mode === intake.requestedMode ? "requested" : "rotation",
        ...(priorMode !== undefined ? { priorMode } : {}),
      };
    });

    const selected = await wf.step.code("07-select-candidate", (): LinkedInSelectedCandidate => {
      // Single post selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // scout's on-brand trend, then the research-derived fallback.
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }
      if (clientContext.requestedTopic) {
        return { topic: clientContext.requestedTopic, source: "requested" };
      }
      const trend = scout !== undefined ? selectTrendCandidate(scout.candidates, modeSelection.mode, { avoidTopics: recentDecisions.summaries }) : undefined;
      if (trend !== undefined && intake.trendJacking === "always" && trend.brandFit >= 4 && reservation.topics.length > 0) {
        return { topic: trend.topic, source: "trend", trend };
      }
      if (reservation.topics.length > 0) {
        return { topic: reservation.topics[0]!, source: "reserved" };
      }
      if (trend !== undefined) {
        return { topic: trend.topic, source: "trend", trend };
      }
      if (candidateSummary.candidateTopic) {
        return { topic: candidateSummary.candidateTopic, source: "research" };
      }
      throw new WorkflowHeld("no candidate topic available for this run — nothing honestly cleared selection");
    });

    /**
     * The restored lane/mix decision tree (`lanes.md` §2's style-choice
     * rule, Phase 2.5 Batch 2.2). Precedence: (1) an explicit run
     * request/standing direction names the archetype directly and takes the
     * slot exactly as asked, even if it repeats the last post's archetype —
     * "the customer's request wins" is unconditional; (2) otherwise a real
     * round-robin rotation applies. This is the "never the same lane as this
     * identity's last post" rule — a real, checkable constraint against
     * `recentDecisions`, not just a comment.
     *
     * Phase 2.5 fix-batch: the original rotation always rescanned the fixed
     * priority order from position 0, which only ever landed on `order[0]` or
     * `order[1]` — a 2-cycle oscillation that left 9 of the 11 archetypes
     * structurally unreachable. The fix rotates the SCAN'S OWN STARTING POINT
     * by the total number of prior decisions before applying the same "skip
     * the immediate predecessor" rule.
     *
     * 2026-09: the scan prefers the archetype FAMILY of this run's content
     * mode (`ARCHETYPES_FOR_MODE`) — a hot-news week draws an
     * industry-reaction, a deep-value week a teardown or a lesson — and
     * falls back to the whole menu only when every family member is the one
     * just used. A scouted trend that carries a numeric finding uses the
     * numeric ordering like any other numeric candidate.
     */
    const archetypeSelection = await wf.step.code("08-determine-archetype", (): LinkedInArchetypeSelection => {
      const priorArchetype = recentDecisions.lastArchetype;
      const mode = modeSelection.mode;
      if (clientContext.requestedArchetype) {
        return {
          archetype: clientContext.requestedArchetype,
          source: "requested",
          mode,
          ...(priorArchetype !== undefined ? { priorArchetype } : {}),
        };
      }
      const numeric = candidateSummary.hasNumericInsight || selected.trend?.hasNumbers === true;
      const order = numeric ? NUMERIC_INSIGHT_ARCHETYPE_ORDER : DEFAULT_ARCHETYPE_ORDER;
      const rotationIndex = recentDecisions.summaries.length % order.length;
      const rotatedOrder = [...order.slice(rotationIndex), ...order.slice(0, rotationIndex)];
      const family = ARCHETYPES_FOR_MODE[mode];
      const archetype =
        rotatedOrder.find((candidate) => candidate !== priorArchetype && family.includes(candidate)) ??
        rotatedOrder.find((candidate) => candidate !== priorArchetype) ??
        rotatedOrder[0]!;
      return {
        archetype,
        source: "rotation",
        mode,
        ...(priorArchetype !== undefined ? { priorArchetype } : {}),
      };
    });

    // ── 08b: media the client attached, read by a vision model BEFORE drafting ──
    const attachedMedia = await analyzeAttachedMedia(wf, tools, ctx, {
      stepId: "08b-analyze-attached-media",
      repoRoot: options.repoRoot,
      assets: runDirection.mediaAssets,
    });
    const attachedForDrafting = attachedMediaForDrafting(attachedMedia);

    // The research itself, shaped for the drafting prompt: every fetched
    // source's title, url, date and excerpt. Until 2026-09 the draft was handed
    // a headline and nothing else. A pure function of step 04's output.
    const researchDigest = researchDigestForDrafting(research.merged);
    const researchSources = (researchDigest ?? []).filter((d) => d.url !== undefined).map((d) => ({ url: d.url!, title: d.title }));

    // ── 09-14: draft execution via LinkedInDraftAgent, with machine/claim/compliance/hygiene gates ──
    const draftAgent = new LinkedInDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    /**
     * One full drafting pass: draft, every deterministic content gate, the
     * media resolution, then the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-drafts instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (intake,
     * research, the topic reservation) keeps its id and is reused. That
     * reuse is why the revision is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<LinkedInDraftWithMedia> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── 09/09a: draft, then VERIFY it is not a repeat, before anything else ──
      //
      // `recentPosts` in the drafting input below is ADVISORY: it asks the model
      // not to repeat itself and nothing ever checked whether it listened, so a
      // lightly-reworded reissue of last week's post passed every gate. 09a is
      // the verification half — the same `checkOutputDedupe` primitive, scoring
      // the same excerpt window the read above pulled, with `evaluateDedupe`'s
      // calibrated trigram-Jaccard threshold, inside the drafting pass, so a
      // `similar` verdict COSTS the draft and the human at step 15 can never be
      // shown a draft that has not been scored.
      //
      // On the final attempt the draft ships FLAGGED rather than held — two
      // posts a fortnight apart about the same launch may be exactly right, and
      // a fixed threshold is not entitled to overrule the person reviewing at
      // 15. The verdict is checkpointed either way.
      //
      // The scored text is exactly what step 18 records back into the window
      // (`draft.text`, after the formatting reflow), so every future run
      // compares like with like.
      const draftWithVerifiedDedupe = async (): Promise<LinkedInPostOutput> => {
        /** Set by a failed 09a check, so the NEXT attempt's prompt names exactly which published post to move away from. */
        let dedupeRetrySteer: string | undefined;
        for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
          /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
          const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
          const draftResult = await wf.step.agent(rev(att("09-draft-post")), draftAgent, {
            ...runDirectionField(runDirection),
            topic: selected.topic,
            source: selected.source,
            archetype: archetypeSelection.archetype,
            contentMode: modeSelection.mode,
            voiceRules: clientContext.voiceRules,
            identity: clientContext.identity,
            // The client's own profile description + voice-rules guidelines,
            // verbatim — this is where a language requirement like Geektime's
            // "Hebrew-language technology site" actually lives.
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            // The research the post is written from, and the scouted story
            // when one took the slot.
            ...(researchDigest !== undefined ? { research: researchDigest } : {}),
            ...(selected.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(selected.trend) } : {}),
            // What the client attached, as a vision model described it.
            ...(attachedForDrafting !== undefined ? { attachedMedia: attachedForDrafting } : {}),
            ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
            ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
            // Omitted rather than passed as null when absent (see x-agent).
            ...(clientContext.strategy ? { accountCharter: clientContext.strategy } : {}),
            // Two distinct steers, kept apart on purpose: `pastFeedback` is what
            // this client has said across previous RUNS, `revisionRequest` is what
            // a reviewer asked about THIS draft minutes ago.
            ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
            ...(directive !== undefined ? { revisionRequest: directive } : {}),
          });

          if (draftResult.status === "content_fail") {
            throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
          }
          if (draftResult.status !== "completed") {
            throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
          }
          // The formatting reflow happens HERE, before the dedupe score and
          // every gate, so everything downstream — the recorded excerpt, the
          // gates, the reviewer — sees the exact text that ships. Whitespace
          // only; not a word of the model's prose changes.
          const raw = draftResult.finalOutput!;
          const candidate: LinkedInPostOutput = { ...raw, text: reflowLinkedInText(raw.text) };

          const dedupeVerdict = await checkOutputDedupe(wf, rev(att("09a-verify-not-duplicate")), candidate.text, outputHistory);
          if (dedupeVerdict.status === "similar" && attempt < MAX_DEDUPE_ATTEMPTS) {
            dedupeRetrySteer = dedupeRetryDirective(dedupeVerdict, outputHistory);
            continue;
          }
          return candidate;
        }
        // Unreachable: the loop's last attempt always returns, because the
        // `continue` above is guarded on `attempt < MAX_DEDUPE_ATTEMPTS`.
        throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
      };
      const draft = await draftWithVerifiedDedupe();

      // ── 09b: the shape check — notes for the reviewer, never a hold ──
      //
      // The reflow above already put the post into LinkedIn's rhythm; this
      // records what it could not fix (a single 300-character sentence, a
      // takeaway the model stated but never wrote into the post). A finding
      // here is an editorial call for the human at 15, not a reason to spend
      // another drafting pass or hold a post whose content cleared every gate.
      const formatting = await wf.step.code(rev("09b-verify-formatting"), () => checkLinkedInFormatting(draft.text, draft.takeaway));

      await wf.step.code(rev("10-verify-numbers-sourced"), async () => {
        // What a figure in the post may be traced to: the full text of every
        // research document (the gate verifies against CONTENT; a URL alone
        // verifies nothing), the client's own intel context, the run's topic,
        // the scouted story, and any legible text in an attached image. Until
        // 2026-09 this was `[sourceLabel]`, so every number a draft quoted
        // faithfully from a real source was held anyway.
        const sources = [
          ...researchSourceTexts(research.merged),
          ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
          selected.topic,
          ...(selected.trend !== undefined ? [selected.trend.headline, selected.trend.angle] : []),
          ...(attachedMedia?.analyses.flatMap((a) => a.textInImage) ?? []),
          ...(candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : []),
        ];
        const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("11-verify-brand-compliance"), async () => {
        const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
        const requiredDisclaimer = clientContext.brand["requiredDisclaimer"] as string | undefined;
        const verdict = await runGate(
          tools,
          "gate.brandCompliance",
          { text: draft.text, forbiddenTerms: forbiddenTerms ?? [], ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) },
          ctx,
        );
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("12-render-preview-check"), async () => {
        const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
        const preview = outcome.result as RenderPreviewResult;
        if (!preview.withinLimit) {
          throw new WorkflowHeld(`post exceeds the LinkedIn character limit (${preview.characterCount} chars)`);
        }
        return preview;
      });

      // gate.noPlaceholder and gate.leakCheck exist in packages/tools/karos-gates
      // but were never wired into any channel's runtime step sequence before
      // Phase 2.5 — restored here, run before the human ever sees the draft.
      await wf.step.code(rev("13-verify-no-placeholder"), async () => {
        const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft contains an unresolved placeholder: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("14-verify-no-leak"), async () => {
        const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft appears to leak sensitive content: ${verdict.reason}`);
        return verdict;
      });

      // ── 14b: the post's media — attached first, then the draft's own brief ──
      //
      // After every text gate, so a held draft never pays for a screenshot or
      // a generation; inside the revision loop, because a revised post may want
      // a different picture. Never holds.
      const mediaPlan = await resolveSocialMedia(wf, tools, ctx, {
        stepId: rev("14b-resolve-media"),
        repoRoot: options.repoRoot,
        platform: "linkedin",
        brief: draft.mediaBrief,
        attached: attachedMedia,
        sources: researchSources,
        postText: draft.text,
        art: artDirectionFromBrand(clientContext.brand),
      });

      // ── terminal topic guardrail ──
      //
      // Before the human gate: a reviewer should never be shown a draft that
      // engages a subject this client said it does not touch. Not a repeat of
      // gate.brandCompliance -- that matches forbiddenTerms as substrings and
      // catches the word, while this judges the subject. Free for a client who
      // forbids nothing: no list, no step, no model call.
      await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, draft.text, intake.forbiddenTopics, revision === 0 ? undefined : `-r${revision}`);

      return { ...draft, mediaPlan, formatting };
    };

    // ── 15: the universal approve / revise / reject cycle ──
    //
    // `revise` re-drafts with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and
    // forcing somebody to dispatch a fresh one that knows nothing about the
    // feedback. Every decision, approvals included, reaches client memory.
    const review = await runReviewCycle(wf, {
      gateId: "15-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          topic: selected.topic,
          archetype: draft.archetype,
          contentMode: modeSelection.mode,
          preview: draft.text,
          takeaway: draft.takeaway,
          ...(draft.formatting.notes.length > 0 ? { formattingNotes: draft.formatting.notes } : {}),
          ...mediaForDeliverable(draft.mediaPlan),
          ...(selected.trend !== undefined ? { trend: { whyNow: selected.trend.whyNow, brandFitReason: selected.trend.brandFitReason, sourceUrls: selected.trend.sourceUrls } } : {}),
          revision,
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
      },
    });
    const { mediaPlan, formatting, ...draft } = review.output;

    // ── 16-17: deliverable & manifest persistence ──
    // Additive: `draftsMarkdown` is the "# LinkedIn drafts"-shaped string
    // karosCMO's `li-drafts.ts` parser needs on `asset.content` — the rest
    // of `draft` stays untouched for any consumer that wants raw fields. The
    // media block rides beside it.
    const profileCompanyName = clientContext.profile["companyName"];
    const draftsMarkdown = renderLinkedInDraftsMarkdown({
      identity: clientContext.identity,
      ...(typeof profileCompanyName === "string" ? { companyName: profileCompanyName } : {}),
      archetype: draft.archetype,
      topic: selected.topic,
      draft,
      media: mediaPlan,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "16-persist-deliverable",
      persistManifestStepId: "17-persist-manifest",
      kind: "linkedin-post",
      deliverable: {
        ...draft,
        ...mediaForDeliverable(mediaPlan),
        contentMode: modeSelection.mode,
        formattingNotes: formatting.notes,
        ...(selected.trend !== undefined ? { trend: selected.trend } : {}),
        draftsMarkdown,
      },
      snapshot: (deliverableId) => ({
        topic: selected.topic,
        source: selected.source,
        archetype: draft.archetype,
        contentMode: modeSelection.mode,
        mediaStatus: mediaPlan.status,
        deliverableId,
      }),
    });

    // ── 18: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("18-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "linkedin-agent", draft.text);
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          // `(archetype: …)` feeds the never-repeat rule and `(mode: …)` the
          // content-mode rotation on every future run.
          summary: `Posted about "${selected.topic}" (archetype: ${draft.archetype}, mode: ${modeSelection.mode})`,
        },
        { ctx },
      );
    });

    return {
      topic: selected.topic,
      archetype: draft.archetype,
      contentMode: modeSelection.mode,
      targetAudience: draft.targetAudience,
      takeaway: draft.takeaway,
      deliverableId,
      mediaStatus: mediaPlan.status,
      formattingNotes: formatting.notes,
      channelSetup: channelSetup.status,
      preview: draft.text,
    };
  };
}
