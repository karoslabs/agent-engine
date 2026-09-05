import { z } from "zod";
import type { AgentContext, AgentToolRegistry, MediaAsset } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * Media for the text-first channels (X, LinkedIn), shared.
 *
 * ## The rule, in one paragraph
 *
 * A picture the client attached outranks everything, and the copy is written
 * TO it — so it is analysed first, before a word is drafted. Otherwise the
 * draft says what it needs (`MediaBrief`), and the need is answered from the
 * cheapest honest source up: a screenshot of the cited page (the artefact X
 * rewards), the cited article's own lead image, then stock. AI generation is
 * the LAST resort and runs only when the post genuinely needs a visual and
 * every real source came up empty — never by default, never for a post that
 * reads fine as text. Every candidate that a vision tool can see is judged
 * against the brief before it is chosen; nothing is picked from alt text when
 * pixels are available.
 *
 * ## Why shared
 *
 * Instagram has had a tiered pipeline for a year; X and LinkedIn had nothing
 * — `mediaRefs` was an always-empty array and a LinkedIn post had no media
 * field at all. Two more per-agent copies of the tier logic would be the
 * fourth and fifth places the rule could drift. This is the one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The brief the draft produces
// ─────────────────────────────────────────────────────────────────────────────

export const MEDIA_BRIEF_KINDS = ["screenshot", "photo", "none"] as const;

export const MediaBriefSchema = z.object({
  /** Whether this post is better with a visual at all. A sharp text post is a complete deliverable. */
  needsVisual: z.boolean(),
  /** screenshot: the cited page itself. photo: a real, photographable scene. none: text only. */
  kind: z.enum(MEDIA_BRIEF_KINDS),
  /** For `photo`: a 3-8 word stock search phrase (one subject, one setting). For `screenshot`: unused. */
  query: z.string().optional(),
  /** For `screenshot`: which cited URL to capture. Must be one of the research sources. */
  sourceUrl: z.string().optional(),
  /** One sentence on why this visual, or why none. Shown to the reviewer. */
  rationale: z.string().min(1),
});
export type MediaBrief = z.infer<typeof MediaBriefSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Tier 0: what the client attached
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachedMediaAnalysis {
  /** Repo-relative path in the run's media cache. */
  path: string;
  label?: string;
  description: string;
  subjects: string[];
  textInImage: string[];
  mood: string;
  looksLikeScreenshot: boolean;
  suggestedAngle?: string;
}

export interface AnalyzeAttachedMediaOptions {
  stepId: string;
  repoRoot: string | undefined;
  assets: readonly MediaAsset[];
}

/**
 * Ingests the run's attached images and asks the vision tool what is in them.
 *
 * Best-effort at every seam, on purpose: a run whose upload cannot be read, or
 * whose deployment has no vision backend, drafts as it always did — the trace
 * records why. Returns `undefined` when there is nothing to analyse, so a
 * caller spreads the result conditionally and a run without attachments has a
 * byte-identical drafting input.
 */
export async function analyzeAttachedMedia(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: AnalyzeAttachedMediaOptions,
): Promise<{ analyses: AttachedMediaAnalysis[]; note?: string } | undefined> {
  const usable = options.assets.filter((a) => (a.role === "source" || a.role === "reference") && !isVideo(a));
  if (usable.length === 0) return undefined;
  const result = await wf.step.code(options.stepId, async (): Promise<{ analyses: AttachedMediaAnalysis[]; note?: string }> => {
    const ingest = tools["media.ingestAssets"];
    const inspect = tools["media.inspectImages"];
    if (options.repoRoot === undefined) return { analyses: [], note: "no repoRoot configured, attachments cannot be ingested" };
    if (ingest === undefined) return { analyses: [], note: "media.ingestAssets is not registered" };

    const ingested = await ingest.execute(
      {
        repoRoot: options.repoRoot,
        runId: wf.runId,
        assets: usable.map((asset, index) => ({ uri: asset.uri, ...(asset.label ? { label: asset.label } : {}), slot: index + 1 })),
      },
      { ctx },
    );
    if (ingested.status !== "success") {
      return { analyses: [], note: `attachments could not be ingested (${ingested.status}${"reason" in ingested ? `: ${ingested.reason}` : ""})` };
    }
    const candidates = (ingested.result as { candidates: Array<{ path: string; description: string }> }).candidates;
    if (candidates.length === 0) return { analyses: [], note: "no attachment was ingested" };

    if (inspect === undefined) {
      // No vision: the copy still learns the client attached SOMETHING, with
      // the uploader's own label as the only description available.
      return {
        analyses: candidates.map((c, i) => ({
          path: c.path,
          ...(usable[i]?.label ? { label: usable[i]!.label! } : {}),
          description: usable[i]?.label ?? "an image the client attached to this run (no vision backend to describe it)",
          subjects: [],
          textInImage: [],
          mood: "",
          looksLikeScreenshot: false,
        })),
        note: "media.inspectImages is not registered; attachments described from their labels only",
      };
    }

    const inspected = await inspect.execute(
      {
        repoRoot: options.repoRoot,
        images: candidates.map((c, i) => ({ ref: `attached-${i + 1}`, path: c.path })),
        purpose: "attached-media",
      },
      { ctx },
    );
    if (inspected.status !== "success") {
      return {
        analyses: candidates.map((c, i) => ({
          path: c.path,
          ...(usable[i]?.label ? { label: usable[i]!.label! } : {}),
          description: usable[i]?.label ?? "an image the client attached to this run",
          subjects: [],
          textInImage: [],
          mood: "",
          looksLikeScreenshot: false,
        })),
        note: `vision inspection did not complete (${inspected.status}${"reason" in inspected ? `: ${inspected.reason}` : ""})`,
      };
    }
    const inspections = (inspected.result as { inspections: Array<Record<string, unknown>> }).inspections;
    const byRef = new Map(inspections.map((i) => [i["ref"] as string, i]));
    return {
      analyses: candidates.map((c, i) => {
        const found = byRef.get(`attached-${i + 1}`);
        return {
          path: c.path,
          ...(usable[i]?.label ? { label: usable[i]!.label! } : {}),
          description: (found?.["description"] as string | undefined) ?? usable[i]?.label ?? "an image the client attached to this run",
          subjects: (found?.["subjects"] as string[] | undefined) ?? [],
          textInImage: (found?.["textInImage"] as string[] | undefined) ?? [],
          mood: (found?.["mood"] as string | undefined) ?? "",
          looksLikeScreenshot: Boolean(found?.["looksLikeScreenshot"]),
          ...(typeof found?.["suggestedAngle"] === "string" ? { suggestedAngle: found["suggestedAngle"] as string } : {}),
        };
      }),
    };
  });
  return result.analyses.length > 0 ? result : { analyses: [], ...(result.note ? { note: result.note } : {}) };
}

function isVideo(asset: MediaAsset): boolean {
  if (asset.contentType?.startsWith("video/")) return true;
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(asset.uri);
}

/** The attached-media block for a drafting prompt, or undefined when there is none. */
export function attachedMediaForDrafting(analysis: { analyses: AttachedMediaAnalysis[] } | undefined): Array<Record<string, unknown>> | undefined {
  if (!analysis || analysis.analyses.length === 0) return undefined;
  return analysis.analyses.map((a) => ({
    ...(a.label !== undefined ? { label: a.label } : {}),
    description: a.description,
    subjects: a.subjects,
    textInImage: a.textInImage,
    mood: a.mood,
    looksLikeScreenshot: a.looksLikeScreenshot,
    ...(a.suggestedAngle !== undefined ? { suggestedAngle: a.suggestedAngle } : {}),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiers 1-3: answering the brief
// ─────────────────────────────────────────────────────────────────────────────

export type SocialMediaStatus = "attached" | "screenshot" | "harvested" | "stock" | "generated" | "none";

export interface SocialMediaAsset {
  /** Repo-relative path in the run's media cache. */
  path: string;
  /** A fetchable URL once staged (signed https, or gs://). Absent when no media store is configured. */
  url?: string;
  gcsUri?: string;
  description: string;
  provider: string;
  licenseConfidence: string;
  /** True for a publisher image or a page screenshot — the post must link/credit the source. */
  requiresCredit: boolean;
  creditUrl?: string;
  /** What the vision tool said, when it looked. */
  inspection?: Record<string, unknown>;
}

export interface SocialMediaPlan {
  status: SocialMediaStatus;
  asset?: SocialMediaAsset;
  /** Why this outcome — shown to the reviewer beside the preview. */
  rationale: string;
  /** Every tier tried, in order, with its result. */
  attempts: string[];
}

export interface ResolveSocialMediaOptions {
  stepId: string;
  repoRoot: string | undefined;
  platform: "x" | "linkedin";
  brief: MediaBrief | undefined;
  attached: { analyses: AttachedMediaAnalysis[] } | undefined;
  /** The research documents the draft cites — candidates for a screenshot or a lead image. */
  sources: ReadonlyArray<{ url: string; title?: string | undefined }>;
  /** The draft's own text, so vision can reject an image that merely repeats it. */
  postText: string;
  /** Art direction for the generative tier, from the client's brand tokens. */
  art?: { aesthetic?: string; lighting?: string; palette?: string[]; accentColor?: string; mood?: string } | undefined;
}

/** Minimum vision fit score for a sourced candidate to be chosen. */
export const MIN_MEDIA_FIT_SCORE = 3;

/**
 * The realism direction every generated fallback carries. A generated image
 * that LOOKS generated is the one outcome worse than no image: it tells the
 * reader the account is automated.
 */
export const REALISTIC_GENERATION_NOTES =
  "Photorealistic editorial photograph, as if shot by a working photojournalist: natural light, real textures and small imperfections, candid framing, one clear subject. " +
  "Not an illustration, not a 3D render, no glossy sheen, no surreal or fantasy elements, no exaggerated saturation, no perfect symmetry, no floating objects or glowing abstract shapes, no faces in close-up.";

const ASPECT_FOR_PLATFORM: Record<ResolveSocialMediaOptions["platform"], "16:9" | "1:1"> = { x: "16:9", linkedin: "1:1" };
const VIEWPORT_FOR_PLATFORM: Record<ResolveSocialMediaOptions["platform"], { width: number; height: number }> = {
  x: { width: 1200, height: 675 },
  linkedin: { width: 1200, height: 1200 },
};

interface Candidate {
  path: string;
  description: string;
  provider: string;
  licenseConfidence: string;
  sourceUrl?: string;
}

/**
 * Resolves the post's media, one checkpointed step.
 *
 * Never throws for a media reason: every tier's failure is recorded in
 * `attempts` and the plan degrades to `none`. A post with no picture ships; a
 * post held over a stock outage does not, and the second is the worse outcome.
 */
export async function resolveSocialMedia(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: ResolveSocialMediaOptions,
): Promise<SocialMediaPlan> {
  return wf.step.code(options.stepId, async (): Promise<SocialMediaPlan> => {
    const attempts: string[] = [];
    const stage = async (candidate: Candidate, status: SocialMediaStatus, inspection?: Record<string, unknown>): Promise<SocialMediaPlan> => {
      const asset: SocialMediaAsset = {
        path: candidate.path,
        description: candidate.description,
        provider: candidate.provider,
        licenseConfidence: candidate.licenseConfidence,
        requiresCredit: status === "screenshot" || status === "harvested",
        ...(candidate.sourceUrl !== undefined ? { creditUrl: candidate.sourceUrl } : {}),
        ...(inspection !== undefined ? { inspection } : {}),
      };
      const staging = tools["media.stageAsset"];
      if (staging !== undefined && options.repoRoot !== undefined) {
        const staged = await staging.execute({ repoRoot: options.repoRoot, runId: wf.runId, path: candidate.path }, { ctx });
        if (staged.status === "success") {
          const result = staged.result as { url: string; gcsUri: string };
          asset.url = result.url;
          asset.gcsUri = result.gcsUri;
          attempts.push(`staged: ${result.url}`);
        } else {
          attempts.push(`staging: ${staged.status}${"reason" in staged ? ` (${staged.reason})` : ""} — the local path stays in the trace`);
        }
      }
      return { status, asset, rationale: rationaleFor(status, options.brief), attempts };
    };

    // ── Tier 0: the client's own upload wins, always ──
    const attached = options.attached?.analyses[0];
    if (attached !== undefined) {
      attempts.push("attached: the client supplied media for this run");
      return stage(
        { path: attached.path, description: attached.description, provider: "client-upload", licenseConfidence: "client-supplied" },
        "attached",
      );
    }

    const brief = options.brief;
    if (brief === undefined || !brief.needsVisual || brief.kind === "none") {
      attempts.push(brief === undefined ? "no media brief on the draft" : `draft asked for no visual: ${brief.rationale}`);
      return { status: "none", rationale: brief?.rationale ?? "the draft carried no media brief, so the post ships as text", attempts };
    }
    if (options.repoRoot === undefined) {
      attempts.push("no repoRoot configured — sourcing tiers need a bounded media cache");
      return { status: "none", rationale: "this deployment has no media cache root, so no visual could be sourced", attempts };
    }
    const repoRoot = options.repoRoot;

    const inspect = tools["media.inspectImages"];
    /** Judges candidates against the brief with vision when available; otherwise passes them through in order. */
    const pickBest = async (candidates: Candidate[], tier: string): Promise<{ candidate: Candidate; inspection?: Record<string, unknown> } | undefined> => {
      if (candidates.length === 0) return undefined;
      if (inspect === undefined) {
        attempts.push(`${tier}: ${candidates.length} candidate(s), no vision backend — taking the first`);
        return { candidate: candidates[0]! };
      }
      const outcome = await inspect.execute(
        {
          repoRoot,
          images: candidates.slice(0, 12).map((c, i) => ({ ref: `${tier}-${i + 1}`, path: c.path })),
          brief: briefText(brief, options.postText),
          purpose: "candidate-vetting",
        },
        { ctx },
      );
      if (outcome.status !== "success") {
        attempts.push(`${tier}: ${candidates.length} candidate(s), vision inspection ${outcome.status} — taking the first`);
        return { candidate: candidates[0]! };
      }
      const inspections = (outcome.result as { inspections: Array<Record<string, unknown>> }).inspections;
      const scored = inspections
        .map((i) => ({ i, candidate: candidates[Number(String(i["ref"]).split("-").at(-1)) - 1] }))
        .filter((s): s is { i: Record<string, unknown>; candidate: Candidate } => s.candidate !== undefined)
        .filter((s) => s.i["quality"] !== "unusable" && s.i["hasWatermark"] !== true && s.i["looksAiGenerated"] !== true)
        .filter((s) => typeof s.i["fitScore"] !== "number" || (s.i["fitScore"] as number) >= MIN_MEDIA_FIT_SCORE)
        .sort((a, b) => ((b.i["fitScore"] as number | undefined) ?? 0) - ((a.i["fitScore"] as number | undefined) ?? 0));
      if (scored.length === 0) {
        attempts.push(`${tier}: ${candidates.length} candidate(s), none cleared vision (fit ≥ ${MIN_MEDIA_FIT_SCORE}, no watermark, usable)`);
        return undefined;
      }
      attempts.push(`${tier}: chose ${scored[0]!.candidate.path} (fit ${String(scored[0]!.i["fitScore"] ?? "n/a")})`);
      return { candidate: scored[0]!.candidate, inspection: scored[0]!.i };
    };

    // ── Tier 1a: a screenshot of the cited page ──
    if (brief.kind === "screenshot") {
      const screenshot = tools["media.screenshotPage"];
      const url = brief.sourceUrl && options.sources.some((s) => s.url === brief.sourceUrl) ? brief.sourceUrl : options.sources[0]?.url;
      if (screenshot === undefined) attempts.push("screenshot: media.screenshotPage is not registered");
      else if (url === undefined) attempts.push("screenshot: the draft named no cited source to capture");
      else {
        const title = options.sources.find((s) => s.url === url)?.title;
        const outcome = await screenshot.execute({ repoRoot, runId: wf.runId, url, ...(title ? { title } : {}), viewport: VIEWPORT_FOR_PLATFORM[options.platform] }, { ctx });
        if (outcome.status === "success") {
          const candidate = (outcome.result as { candidate: Candidate }).candidate;
          const picked = await pickBest([candidate], "screenshot");
          if (picked) return stage(picked.candidate, "screenshot", picked.inspection);
        } else {
          attempts.push(`screenshot: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        }
      }
    }

    // ── Tier 1b: the cited articles' own lead images ──
    const harvest = tools["media.harvestArticleImages"];
    if (harvest !== undefined && options.sources.length > 0) {
      const outcome = await harvest.execute(
        { repoRoot, runId: wf.runId, sources: options.sources.slice(0, 4).map((s) => ({ url: s.url, ...(s.title ? { title: s.title } : {}) })) },
        { ctx },
      );
      if (outcome.status === "success") {
        const picked = await pickBest((outcome.result as { candidates: Candidate[] }).candidates, "article");
        if (picked) return stage(picked.candidate, "harvested", picked.inspection);
      } else {
        attempts.push(`article: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      }
    } else if (harvest === undefined) {
      attempts.push("article: media.harvestArticleImages is not registered");
    }

    // ── Tier 1c: stock and CC libraries, for any brief that named a search phrase ──
    //
    // A screenshot brief that also carries a `query` falls through to a real
    // photograph when the page could not be captured; a brief with no query
    // has nothing to search for and stops here.
    const findImages = tools["media.findImages"];
    if (brief.query && findImages !== undefined) {
      const outcome = await findImages.execute({ repoRoot, runId: wf.runId, needs: [{ n: 1, query: brief.query, route: "default" }], perNeed: 3, maxPerNeed: 6 }, { ctx });
      if (outcome.status === "success") {
        const picked = await pickBest((outcome.result as { candidates: Candidate[] }).candidates, "stock");
        if (picked) return stage(picked.candidate, "stock", picked.inspection);
      } else {
        attempts.push(`stock: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      }
    } else if (brief.query && findImages === undefined) {
      attempts.push("stock: media.findImages is not registered");
    }

    // ── Tier 3: generation — the last resort, and only for a photo brief ──
    const generate = tools["image.generate"];
    if (brief.kind === "photo" && brief.query && generate !== undefined) {
      const outcome = await generate.execute(
        {
          repoRoot,
          runId: wf.runId,
          needs: [{ n: 1, prompt: brief.query }],
          aspectRatio: ASPECT_FOR_PLATFORM[options.platform],
          // The client's art direction plus the realism constraints — the
          // notes field is appended verbatim to the generation brief.
          art: { ...(options.art ?? {}), notes: REALISTIC_GENERATION_NOTES },
        },
        { ctx },
      );
      if (outcome.status === "success") {
        const picked = await pickBest((outcome.result as { candidates: Candidate[] }).candidates, "generated");
        if (picked) return stage(picked.candidate, "generated", picked.inspection);
      } else {
        attempts.push(`generate: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      }
    } else if (brief.kind === "photo" && generate === undefined) {
      attempts.push("generate: image.generate is not registered");
    }

    return { status: "none", rationale: "the draft asked for a visual but no source could honestly supply one; the post ships as text", attempts };
  });
}

function briefText(brief: MediaBrief, postText: string): string {
  const need = brief.kind === "screenshot" ? `a legible capture of the cited page${brief.sourceUrl ? ` (${brief.sourceUrl})` : ""}` : brief.query ?? brief.rationale;
  return `${need}. The post says: "${postText.slice(0, 400)}". Reject a cookie wall, a blank page, a watermark, or an image that only repeats the post's own words.`;
}

function rationaleFor(status: SocialMediaStatus, brief: MediaBrief | undefined): string {
  switch (status) {
    case "attached":
      return "the client attached this image; the post was written to it";
    case "screenshot":
      return `a screenshot of the cited page — ${brief?.rationale ?? "the artefact the post is about"}`;
    case "harvested":
      return `the cited article's own lead image, credited — ${brief?.rationale ?? ""}`.trim();
    case "stock":
      return `a licensed stock photograph matching the brief — ${brief?.rationale ?? ""}`.trim();
    case "generated":
      return `generated as a last resort: the post needed a visual and no real source supplied one — ${brief?.rationale ?? ""}`.trim();
    case "none":
      return brief?.rationale ?? "no visual";
  }
}

/** The media block a deliverable and a review gate carry. */
export function mediaForDeliverable(plan: SocialMediaPlan): Record<string, unknown> {
  return {
    mediaStatus: plan.status,
    mediaRationale: plan.rationale,
    ...(plan.asset !== undefined
      ? {
          media: {
            url: plan.asset.url ?? plan.asset.path,
            ...(plan.asset.gcsUri !== undefined ? { gcsUri: plan.asset.gcsUri } : {}),
            path: plan.asset.path,
            description: plan.asset.description,
            provider: plan.asset.provider,
            licenseConfidence: plan.asset.licenseConfidence,
            requiresCredit: plan.asset.requiresCredit,
            ...(plan.asset.creditUrl !== undefined ? { creditUrl: plan.asset.creditUrl } : {}),
          },
        }
      : {}),
  };
}
