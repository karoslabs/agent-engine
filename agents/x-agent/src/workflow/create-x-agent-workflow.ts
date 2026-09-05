import { readForbiddenTopics, type AgentContext, type AgentToolRegistry, type GateResponse, type ModelRouter, type PromptStore } from "@agent-engine/core";
import {
  type WorkflowContext,
  type RevisionNote,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
  runTopicGuardrail,
  extractResearchCandidate,
  researchDigestForDrafting,
  researchSourceTexts,
  readRunDirection,
  runDirectionField,
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
import { MAX_THREAD_PARTS, XDraftAgent, type Lane, type XPostOutput } from "../agent/x-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderXDraftsMarkdown } from "./render-drafts-markdown.js";
import { countRecentEngagementPosts, ENGAGEMENT_DAILY_CAP, LANES_FOR_MODE, selectLane } from "./lane.js";
import type {
  XAgentWorkflowResult,
  XCandidateSummary,
  XClientContext,
  XContentModeSelection,
  XIntakeConfig,
  XRecentDecision,
  XSelectedCandidate,
  XTopicReservation,
} from "./types.js";

export interface CreateXAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 15's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3), matching every migrated channel's own legacy "never auto-publish"
   * guardrail. Intended for tests/demos/evals that need a synchronous
   * happy path, never for production wiring (`apps/agent-server` leaves this
   * unset).
   */
  autoApprove?: boolean;
  /**
   * Bounds root for the media cache (2026-09). Every sourced or attached image
   * lands under `<repoRoot>/.media-cache/<runId>/`, the same directory every
   * other media tool uses. Optional: without it the post ships as text and the
   * media step records why. `apps/agent-server` passes the same root it
   * passes instagram-agent.
   */
  repoRoot?: string | undefined;
}

/** A bare `http(s)://` link — the mechanical half of "post clean, link in first reply" (x-craft.md §5). */
const BARE_URL_PATTERN = /https?:\/\//i;

/**
 * How many drafting passes the verified de-duplication check may cost —
 * initial draft plus two redraft steers, the same budget instagram-agent's
 * `MAX_SELF_CHECK_ATTEMPTS` gives its own 07d dedupe check. On the last
 * attempt a `similar` draft ships FLAGGED (the verdict stays checkpointed for
 * the trace and the reviewer), never held: `evaluateDedupe`'s own policy is
 * that de-duplication flags and steers, it does not hold a run.
 */
const MAX_DEDUPE_ATTEMPTS = 3;

/** The draft plus the media the run resolved for it — what the review gate shows and the deliverable persists. */
type XDraftWithMedia = XPostOutput & { mediaPlan: SocialMediaPlan };

/** Every part of the deliverable as one string, for the gates that judge the whole post (brand, leak, placeholder, topic). */
function fullText(draft: XPostOutput): string {
  return [draft.text, ...draft.thread].join("\n\n");
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

/**
 * `createXAgentWorkflow()` (RFC-02 §3): the recurring/on-demand run
 * protocol, steps `00`–`20`. One post, one run (RFC-01 §16.2's ruling) — no
 * fan-out here, unlike the LinkedIn pilot; every X run produces at most one
 * deliverable (a thread is one deliverable with parts). Step 15 is a
 * mandatory human `batch_review` gate (RFC-01 §8.3) — nothing persists until
 * a real human approves, unless `options.autoApprove` explicitly opts out
 * (tests/demos only).
 *
 * Phase 2.5 batch 2.3 restored two previously-missing pieces of domain logic
 * versus the legacy predecessors (`x-agent-v2` primary, `x-agent` v1
 * secondary):
 *
 * 1. **The lane system** (steps 08-09): `references/lanes.md`'s six content
 *    lanes, a "never the same lane twice in a row" rotation, and an
 *    engagement-lane daily cap check.
 * 2. **"Post clean, link in first reply"** (step 13): a mechanical check
 *    that a link never lands in the post body itself when `firstReplyUrl`
 *    is set (x-craft.md §5).
 *
 * ## The 2026-09 elite-tier upgrade, in the order a run meets it
 *
 * - **04**: research is several questions, not one — the industry's news,
 *   its launches/deals/reports, the client's own name, and the client's
 *   configured `trendQueries` — merged and de-duplicated.
 * - **07a**: when nobody requested a topic and the catalog has none, a
 *   trend SCOUT (Gemini Flash) turns the research into brand-fit-scored
 *   candidates tagged by content mode; the strongest on-brand one takes the
 *   slot. Below `MIN_BRAND_FIT` nothing is forced.
 * - **07b**: the content-mode rotation — hot news / deep value / open
 *   discussion — never the same mode twice in a row, steering the lane.
 * - **09b**: media the client ATTACHED is ingested and read by a vision
 *   model BEFORE drafting, so the post is written to the picture.
 * - **10**: the draft receives the research itself (every source's title,
 *   url, date, excerpt), the trend candidate, the mode and the attached
 *   media — until now it received a headline.
 * - **11**: the numbers gate verifies against source TEXT, the intel context
 *   and the run's topic, not a URL.
 * - **13b**: a thread (parts 2..N) is checked part by part.
 * - **14e**: the media resolver answers the draft's own `mediaBrief`:
 *   screenshot of the cited page, the article's lead image, stock, and only
 *   then generation — never by default, and every candidate vision-judged.
 */
export function createXAgentWorkflow(options: CreateXAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function xAgentWorkflow(wf: WorkflowContext): Promise<XAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

    // ── 00: intake check — blocked_intake if foundation data is missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<XIntakeConfig> => {
      const outcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine an X handle");
      }
      const config = outcome.result as Record<string, unknown>;
      if (typeof config["xHandle"] !== "string" || config["xHandle"].length === 0) {
        throw new WorkflowBlockedIntake("client has not configured an X handle yet");
      }
      // This run's own request wins over the client's standing configuration.
      // `lanes.md`'s rule is "the customer's run request wins", and until the
      // engine could carry a per-run input the only way to express one was to
      // write it into client config -- which every other run for that client
      // would then pick up too.
      //
      // Only run-scoped keys are overlaid. xHandle and xStrategyKey are client
      // identity, not a per-run choice, and letting a job payload rewrite which
      // account a post is drafted for would be a tenancy hole.
      const runScoped: Record<string, unknown> = {};
      for (const key of ["requestedTopic", "requestedLane", "requestedMode"] as const) {
        const value = wf.input[key];
        if (typeof value === "string" && value.trim().length > 0) runScoped[key] = value.trim();
      }
      const trendQueries = readStringList(config, "trendQueries");
      // forbiddenTopics comes out of the SAME read, so the terminal guardrail
      // below needs no second one.
      return {
        ...config,
        ...runScoped,
        forbiddenTopics: readForbiddenTopics(config),
        ...(trendQueries ? { trendQueries } : {}),
        allowThreads: config["xAllowThreads"] !== false,
        trendJacking: config["trendJacking"] === "always" ? "always" : "fallback",
      } as XIntakeConfig;
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<XClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });

      // The account's own setup document. A brand page and a founder's seat
      // share a voice and have opposite charters, so the intake is per account
      // and must never be blended — which is why the document is named by
      // `xStrategyKey` in the client's config rather than guessed from the
      // handle. Falls back to the account-level document.
      //
      // `client.getStrategy` may be absent from a caller's registry entirely
      // (the tool is new); that is the same as having no document, not a
      // crash.
      const getStrategy = tools["client.getStrategy"];
      let strategy: string | null = null;
      if (getStrategy) {
        const attempts = intake.xStrategyKey
          ? [{ agent: "x-agent", key: intake.xStrategyKey }, { agent: "x-agent" }]
          : [{ agent: "x-agent" }];
        for (const args of attempts) {
          const outcome = await getStrategy.execute(args, { ctx });
          if (outcome.status === "success") {
            strategy = (outcome.result as { markdown: string }).markdown;
            break;
          }
        }
      }

      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as XClientContext["voiceRules"]) : {},
        strategy,
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    // Full decision rows (not just summaries) — the lane rotation, the
    // engagement daily cap and the content-mode rotation all need `at`
    // timestamps, not just insertion order.
    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<XRecentDecision[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: XRecentDecision[] };
      return result.items;
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    //
    // Several questions, one step. `${industry} trends this week` alone gave
    // the scout nothing to scout: it returned the week's top-ranked generic
    // pieces and no launch, deal or report that had actually happened. The
    // queries now ask what a strategist would ask, and the client can add
    // their own standing ones (`trendQueries`).
    const industry = (clientContext.profile["industry"] as string | undefined) ?? undefined;
    const companyName = (clientContext.profile["companyName"] as string | undefined) ?? (clientContext.profile["name"] as string | undefined);
    const queries = buildTrendQueries({
      industry,
      companyName,
      configuredQueries: intake.trendQueries,
      requestedTopic: runDirection.topicOverride ?? intake.requestedTopic,
    });
    const research: TrendResearch = await pullTrendResearch(wf, tools, ctx, {
      stepId: "04-research-pull",
      job: "x-news-scan",
      // A client with no industry, no name and no request still gets the one
      // query the step always ran, so the trace is never a silent no-op.
      queries: queries.length > 0 ? queries : [`${industry ?? "this industry"} trends this week`],
      window: "24h",
      // Anti-repetition context: this agent's own prior posts, so the
      // extraction below can steer off a subject already covered.
      historyAgentId: "x-agent",
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): XCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // Kept as the last-resort fallback behind the scout: a run whose scout
      // step did not complete still gets the same honest candidate it always
      // did, never a fabricated one.
      extractResearchCandidate(research.merged, { avoidTopics: recentDecisions.map((d) => d.summary) }),
    );

    // ── 06-09: candidate selection, mode, lane selection and the engagement cap ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<XTopicReservation> => {
      const excludeTopics = recentDecisions.map((d) => d.summary);
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

    // ── 04e: what this client asked for on PREVIOUS runs ──
    //
    // The read side of the feedback flywheel. Without it every run starts from
    // zero and the same correction gets made every week. Bounded and
    // best-effort: it lands in a drafting prompt, and a memory read failing
    // must not stop a run that can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");
    // The anti-repetition read: what this agent already SHIPPED for this
    // client (the excerpt window the commit step below writes back into),
    // formatted as a hard do-not-repeat directive for the draft. Distinct
    // from pastFeedback (what a person SAID about past drafts) the same way
    // decisions are distinct from feedback. Read before the scout, which
    // must not propose what the client just published.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "x-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    // The client intel report AND knowledge base, distilled to what steers
    // copy (voice rows, positioning, whitespace, meeting notes) — the client
    // knowledge this platform holds, read by the scout and the draft alike.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);

    // ── 07a: the trend scout — only when no one planned this run's subject ──
    //
    // A typed or configured topic is the client's own statement; a catalog
    // row is a planned editorial slot with a dedup lock. Both outrank a
    // trend by default (`trendJacking: "fallback"`), so the scout — one
    // Gemini Flash call — runs exactly where the old code fell back to
    // "first headline with a number in it": an empty catalog and no request.
    // `trendJacking: "always"` lets a fresh, high-fit story compete with the
    // catalog for clients whose whole point is being first.
    const wantsScout = !runDirection.topicOverride && !intake.requestedTopic && (reservation.topics.length === 0 || intake.trendJacking === "always");
    let scout: TrendScoutOutput | undefined;
    if (wantsScout) {
      scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "07a-trend-scout", {
        research: researchDigestForScout(research.merged),
        channel: "x",
        clientProfile: clientContext.profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        forbiddenTopics: intake.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
    }

    // ── 07b: the content-mode rotation ──
    //
    // Hot news, deep value, open discussion: never the same twice in a row,
    // least-used first. The mode survives across runs the way the lane does —
    // inside the decision summary, `(mode: hot-news)` — and is parsed back here.
    const modeSelection = await wf.step.code("07b-select-content-mode", (): XContentModeSelection => {
      const recentModes = recentDecisions
        .map((d) => ({ at: typeof d.at === "number" ? d.at : 0, mode: parseContentModeFromSummary(d.summary) }))
        .filter((d): d is { at: number; mode: ContentMode } => d.mode !== undefined)
        .sort((a, b) => a.at - b.at)
        .map((d) => d.mode);
      const priorMode = recentModes.at(-1);
      const mode = selectContentMode(recentModes, intake.requestedMode);
      return {
        mode,
        source: intake.requestedMode !== undefined && mode === intake.requestedMode ? "requested" : "rotation",
        ...(priorMode !== undefined ? { priorMode } : {}),
      };
    });

    const selected = await wf.step.code("07-select-candidate", (): XSelectedCandidate => {
      // Single post selection precedence (RFC-02 §3): an explicit client request wins,
      // then a reserved catalog topic, then the scout's on-brand trend, then the
      // research-derived fallback.
      // Highest precedence, above an explicit requestedTopic's own branch
      // below only when that is absent: a typed instruction is this run's
      // most specific statement of intent.
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }
      if (intake.requestedTopic) {
        return { topic: intake.requestedTopic, source: "requested" };
      }
      const avoidTopics = recentDecisions.map((d) => d.summary);
      const trend = scout !== undefined ? selectTrendCandidate(scout.candidates, modeSelection.mode, { avoidTopics }) : undefined;
      // With `trendJacking: "always"` a fresh, high-fit story outranks the
      // planned row; otherwise the catalog keeps its slot.
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

    // Restored lane system (lanes.md): an explicit request wins, otherwise a
    // deterministic "never twice in a row, least-recently-used, weight as
    // tiebreak" rotation — narrowed (2026-09) to the lanes that carry this
    // run's content mode. `angle` is the scout's when a trend took the slot,
    // else the pre-existing two-value derivation.
    const laneSelection = await wf.step.code("08-select-lane", (): { lane: Lane; angle: string } => {
      const lane = selectLane(intake.requestedLane, recentDecisions, LANES_FOR_MODE[modeSelection.mode]);
      const angle = selected.trend?.angle ?? (candidateSummary.hasNumericInsight ? "data-point" : "trend-observation");
      return { lane, angle };
    });

    // Engagement-lane daily cap (x-craft.md §4: "defaults... 5 actions/day").
    // A no-op for every other lane. Runs before drafting so an over-cap run
    // holds without spending a model call. Per-account/per-roster caps are
    // NOT checked here — there is no roster/account model in this agent yet
    // (a real, honest gap versus legacy's "Roster membership is a compliance
    // gate, not a preference").
    await wf.step.code("09-check-engagement-cap", () => {
      if (laneSelection.lane !== "engagement") {
        return { lane: laneSelection.lane, held: false, engagementCountInWindow: 0 };
      }
      const now = Date.now();
      const countInWindow = countRecentEngagementPosts(recentDecisions, now);
      if (countInWindow >= ENGAGEMENT_DAILY_CAP) {
        throw new WorkflowHeld(
          `engagement lane daily cap reached: ${countInWindow} engagement-lane post(s) already recorded in the last 24h (cap: ${ENGAGEMENT_DAILY_CAP})`,
        );
      }
      return { lane: laneSelection.lane, held: false, engagementCountInWindow: countInWindow };
    });

    // ── 09b: media the client attached, read by a vision model BEFORE drafting ──
    //
    // The copy is written TO the picture, so the picture has to be understood
    // first. No step at all when the run carries no attachments.
    const attachedMedia = await analyzeAttachedMedia(wf, tools, ctx, {
      stepId: "09b-analyze-attached-media",
      repoRoot: options.repoRoot,
      assets: runDirection.mediaAssets,
    });
    const attachedForDrafting = attachedMediaForDrafting(attachedMedia);

    // The research itself, shaped for the drafting prompt: every fetched
    // source's title, url, date and excerpt. Until 2026-09 the draft was handed
    // a headline and nothing else, so a run with real sources drafted from one
    // title (the newsletter agent's prep job sp8ICAFLjKkYWb2DAh8R measured the
    // same defect). A pure function of step 04's checkpointed output.
    const researchDigest = researchDigestForDrafting(research.merged);
    const researchSources = (researchDigest ?? []).filter((d) => d.url !== undefined).map((d) => ({ url: d.url!, title: d.title }));

    // ── 10-14: draft execution via XDraftAgent, with machine/claim/compliance/link gates ──
    const draftAgent = new XDraftAgent({ router: options.router, tools, promptStore: options.promptStore });

    /**
     * One full drafting pass: draft, then every deterministic content gate,
     * then the media resolution, then the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is folded
     * into every checkpointed step id inside it (via `rev`), so a second round
     * genuinely re-drafts instead of short-circuiting on the first round's
     * checkpoints — while everything OUTSIDE it (intake, research, the topic
     * reservation) keeps its id and is reused. That reuse is why the revision
     * is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<XDraftWithMedia> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── 10/10a: draft, then VERIFY it is not a repeat, before anything else ──
      //
      // `recentPosts` in the drafting input below is ADVISORY: it asks the model
      // not to repeat itself and nothing ever checked whether it listened, so a
      // lightly-reworded reissue of last week's post passed every gate. 10a is
      // the verification half — the same `checkOutputDedupe` primitive, scoring
      // the same excerpt window step 04e read with `evaluateDedupe`'s calibrated
      // trigram-Jaccard threshold, in the same place instagram-agent puts its
      // own 07d check: inside the drafting pass, so a `similar` verdict COSTS
      // the draft (it is redrafted with the offending post quoted into the
      // prompt) and the human at step 15 can never be shown a draft that has
      // not been scored.
      //
      // On the final attempt the draft ships FLAGGED rather than held — two
      // posts a fortnight apart about the same launch may be exactly right, and
      // a fixed threshold is not entitled to overrule the person reviewing at
      // 15. The verdict is checkpointed either way.
      //
      // The scored text is exactly what step 20 records back into the window
      // (`draft.text`), so every future run compares like with like.
      const draftWithVerifiedDedupe = async (): Promise<XPostOutput> => {
        /** Set by a failed 10a check, so the NEXT attempt's prompt names exactly which published post to move away from. */
        let dedupeRetrySteer: string | undefined;
        for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
          /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
          const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
          const draftResult = await wf.step.agent(rev(att("10-draft-post")), draftAgent, {
            ...runDirectionField(runDirection),
            topic: selected.topic,
            source: selected.source,
            lane: laneSelection.lane,
            angle: laneSelection.angle,
            contentMode: modeSelection.mode,
            threadAllowed: intake.allowThreads,
            targetHandle: intake.xHandle,
            voiceRules: clientContext.voiceRules,
            // The client's own profile description + voice-rules guidelines,
            // verbatim — this is where a language requirement like Geektime's
            // "Hebrew-language technology site" actually lives.
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            // The research the post is written from, and the scouted story
            // when one took the slot: angle, hook, why-now, brand-fit bridge.
            ...(researchDigest !== undefined ? { research: researchDigest } : {}),
            ...(selected.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(selected.trend) } : {}),
            // What the client attached, as a vision model described it.
            ...(attachedForDrafting !== undefined ? { attachedMedia: attachedForDrafting } : {}),
            ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
            ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
            // Omitted rather than passed as null when absent: an explicit
            // "accountCharter: null" in the payload invites the model to remark on
            // its absence instead of simply working without one.
            ...(clientContext.strategy ? { accountCharter: clientContext.strategy } : {}),
            // Two distinct steers, kept apart: `pastFeedback` is what this client
            // has said across previous RUNS, `revisionRequest` is what a reviewer
            // asked about THIS draft minutes ago.
            ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
            ...(directive !== undefined ? { revisionRequest: directive } : {}),
          });

          if (draftResult.status === "content_fail") {
            throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
          }
          if (draftResult.status !== "completed") {
            throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
          }
          // Phase 2.5 fix-batch: `mainPostText` is schema-required to carry the same
          // content as `text` (see XPostOutputSchema's own doc comment), but that
          // was only ever "enforced by prompt instruction" — every content gate
          // below (`gate.numbersSourced`, `gate.brandCompliance`, `render.preview`,
          // and the agent's own self-critique `gate.lintPost` call) checks `text`
          // only, so a banned phrase, unsourced number, or over-limit string could
          // hide in a diverging `mainPostText` while `text` passed every check.
          // Structurally deriving `mainPostText` from the model's own gated `text`
          // here — rather than trusting the model to keep the two fields in sync,
          // or re-running every gate a second time against a second field — closes
          // that gap by construction: whatever content actually cleared every gate
          // is exactly what step 13's link-placement check (and everything
          // downstream) now sees.
          const candidate: XPostOutput = { ...draftResult.finalOutput!, mainPostText: draftResult.finalOutput!.text };

          const dedupeVerdict = await checkOutputDedupe(wf, rev(att("10a-verify-not-duplicate")), fullText(candidate), outputHistory);
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
      const wholePost = fullText(draft);

      await wf.step.code(rev("11-verify-numbers-sourced"), async () => {
        // What a figure in the post may be traced to: the full text of every
        // research document (the gate verifies against CONTENT, and a URL alone
        // — which is all `sourceLabel` is — verifies nothing), the client's own
        // intel context, the run's topic (a catalog topic or a typed request is
        // the client's own statement), and any legible text in an attached
        // image. Until 2026-09 this was `[sourceLabel]`, so every number a
        // draft quoted faithfully from a real source was held anyway.
        const sources = [
          ...researchSourceTexts(research.merged),
          ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
          selected.topic,
          ...(selected.trend !== undefined ? [selected.trend.headline, selected.trend.angle] : []),
          ...(attachedMedia?.analyses.flatMap((a) => a.textInImage) ?? []),
          ...(candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : []),
        ];
        const verdict = await runGate(tools, "gate.numbersSourced", { text: wholePost, sources }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("12-verify-brand-compliance"), async () => {
        const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
        const verdict = await runGate(tools, "gate.brandCompliance", { text: wholePost, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
        return verdict;
      });

      // "Post clean, link in first reply" (x-craft.md §5): when the draft set a
      // `firstReplyUrl`, the main post body must not ALSO carry a bare link —
      // that means the model put the link in the wrong place. No check runs
      // when `firstReplyUrl` is unset (x-craft.md's own launch-post exception,
      // "the link IS the news", is a judgment call left to the drafting model).
      // A thread part carrying a link is the same mistake in a different slot.
      await wf.step.code(rev("13-verify-link-placement"), () => {
        if (draft.firstReplyUrl && [draft.mainPostText, ...draft.thread].some((part) => BARE_URL_PATTERN.test(part))) {
          throw new WorkflowHeld(
            "the post (or a thread part) contains a bare link even though firstReplyUrl is set — links must go in the first reply, never the post body (x-craft.md §5)",
          );
        }
        return { checked: true };
      });

      // ── 13b: a thread is checked part by part (x-craft@5 §9) ──
      //
      // Part 1 is `text`, checked at 14 as before. Every continuation part is
      // its own post on X and has to clear the same 280-character limit; an
      // account whose charter forbids threads holds here rather than at
      // review. No step at all for a single post, so a plain run's trace is
      // unchanged.
      if (draft.thread.length > 0) {
        await wf.step.code(rev("13b-verify-thread"), async () => {
          if (!intake.allowThreads) {
            throw new WorkflowHeld(`the draft carries ${draft.thread.length} thread part(s) but this account does not publish threads (xAllowThreads: false)`);
          }
          if (draft.thread.length + 1 > MAX_THREAD_PARTS) {
            throw new WorkflowHeld(`the thread runs to ${draft.thread.length + 1} posts; the ceiling is ${MAX_THREAD_PARTS}`);
          }
          const parts: RenderPreviewResult[] = [];
          for (const [index, part] of draft.thread.entries()) {
            const outcome = await tools["render.preview"]!.execute({ text: part }, { ctx });
            if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed on thread part ${index + 2}: ${outcome.status}`);
            const preview = outcome.result as RenderPreviewResult;
            if (!preview.withinLimit) {
              throw new WorkflowHeld(`thread part ${index + 2} exceeds the X character limit (${preview.characterCount} chars)`);
            }
            parts.push(preview);
          }
          return { parts: parts.length + 1, characterCounts: [draft.mainPostText.length, ...parts.map((p) => p.characterCount)] };
        });
      }

      await wf.step.code(rev("14-render-preview-check"), async () => {
        const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
        const preview = outcome.result as RenderPreviewResult;
        if (!preview.withinLimit) {
          throw new WorkflowHeld(`post exceeds the X character limit (${preview.characterCount} chars)`);
        }
        return preview;
      });

      // ── 14c-14d: placeholder and leak checks ──
      //
      // Inside `draftOnce`, before the human gate, matching every sibling channel
      // agent (linkedin 13/14, blog 13/14, newsletter 13/14, reddit 15/16).
      //
      // These used to run as steps 16/17, AFTER `15-batch-review` and outside the
      // revision loop. That put a reviewer's approved draft one step away from a
      // `WorkflowHeld` with no revision path: a leak found post-approval could
      // not be revised, only abandoned, and the reviewer never saw the finding
      // that killed it. Running them here means a placeholder or credential leak
      // surfaces as a revision the reviewer can act on, exactly like every other
      // content check in this loop.
      await wf.step.code(rev("14c-verify-no-placeholder"), async () => {
        const verdict = await runGate(tools, "gate.noPlaceholder", { text: wholePost }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("14d-verify-no-leak"), async () => {
        const verdict = await runGate(tools, "gate.leakCheck", { text: wholePost }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`leak check failed: ${verdict.reason}`);
        return verdict;
      });

      // ── 14e: the post's media — attached first, then the draft's own brief ──
      //
      // After every text gate, so a held draft never pays for a screenshot or
      // a generation; inside the revision loop, because a revised post may want
      // a different picture. Never holds: a post with no picture ships and the
      // rationale rides into the gate payload for the reviewer.
      const mediaPlan = await resolveSocialMedia(wf, tools, ctx, {
        stepId: rev("14e-resolve-media"),
        repoRoot: options.repoRoot,
        platform: "x",
        brief: draft.mediaBrief,
        attached: attachedMedia,
        sources: researchSources,
        postText: draft.text,
        art: artDirectionFromBrand(clientContext.brand),
      });

      // ── 14b: terminal topic guardrail ──
      //
      // Before the human gate, deliberately: a reviewer should never be shown a
      // draft that engages a subject this client said it does not touch. It is
      // NOT what gate.brandCompliance already did two steps up — that matches
      // forbiddenTerms as substrings and catches the word, while this judges the
      // subject, so a post that discusses a forbidden topic fluently without
      // naming it passes the first and fails this.
      //
      // Appended by this workflow rather than read from any editable list, and
      // free for a client who forbids no topics: no list, no model call.
      await runTopicGuardrail(
        wf,
        { tools, promptStore: options.promptStore, router: options.router },
        wholePost,
        intake.forbiddenTopics,
        revision === 0 ? undefined : `-r${revision}`,
      );

      return { ...draft, mediaPlan };
    };

    // ── 15: the universal approve / revise / reject cycle ──
    //
    // `revise` re-drafts with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and forcing
    // somebody to dispatch a fresh one that knows nothing about the feedback.
    // Every decision, approvals included, is written to client memory.
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
          lane: laneSelection.lane,
          angle: laneSelection.angle,
          contentMode: modeSelection.mode,
          preview: draft.text,
          ...(draft.thread.length > 0 ? { thread: draft.thread } : {}),
          ...(draft.firstReplyUrl !== undefined ? { firstReplyUrl: draft.firstReplyUrl } : {}),
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
    const { mediaPlan, ...draft } = review.output;

    // ── 18-19: deliverable & manifest persistence ──
    // Additive: `draftsMarkdown` is the DRAFTS.md-shaped string karosCMO's
    // `x-drafts.ts` parser needs on `asset.content` — the rest of `draft`
    // stays untouched for any consumer that wants the raw structured fields.
    // The media block (`media`, `mediaStatus`, `mediaRationale`) rides beside
    // it; `mediaRefs` carries the staged URL so the portal's existing
    // `metaFields` read picks it up unchanged.
    const draftsMarkdown = renderXDraftsMarkdown({
      targetHandle: intake.xHandle,
      lane: laneSelection.lane,
      angle: laneSelection.angle,
      draft,
      media: mediaPlan,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "18-persist-deliverable",
      persistManifestStepId: "19-persist-manifest",
      kind: "x-post",
      deliverable: {
        ...draft,
        mediaRefs: mediaPlan.asset !== undefined ? [mediaPlan.asset.url ?? mediaPlan.asset.path] : draft.mediaRefs,
        ...mediaForDeliverable(mediaPlan),
        contentMode: modeSelection.mode,
        ...(selected.trend !== undefined ? { trend: selected.trend } : {}),
        draftsMarkdown,
      },
      snapshot: (deliverableId) => ({
        topic: selected.topic,
        source: selected.source,
        lane: laneSelection.lane,
        angle: laneSelection.angle,
        contentMode: modeSelection.mode,
        parts: draft.thread.length + 1,
        mediaStatus: mediaPlan.status,
        deliverableId,
      }),
    });

    // ── 20: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("20-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "x-agent", fullText(draft));
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          // `(lane: …)` feeds the lane rotation and `(mode: …)` the content-mode
          // rotation on every future run — the summary is the only field that
          // survives the decision schema.
          summary: `Posted about "${selected.topic}" (lane: ${laneSelection.lane}, angle: ${laneSelection.angle}, mode: ${modeSelection.mode})`,
        },
        { ctx },
      );
    });

    return {
      topic: selected.topic,
      angle: laneSelection.angle,
      lane: laneSelection.lane,
      contentMode: modeSelection.mode,
      targetHandle: intake.xHandle,
      deliverableId,
      parts: draft.thread.length + 1,
      mediaStatus: mediaPlan.status,
      preview: draft.text,
    };
  };
}
