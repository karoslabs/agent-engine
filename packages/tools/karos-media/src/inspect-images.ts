import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { DEFAULT_VISION_MODEL, type VisionAnalysisClient, type VisionPart } from "./visual-patterns.js";

// 1.0.0 — new: the first tool in this package that LOOKS at pixels on behalf
// of a content agent. Until it, every image judgment in the engine was made
// from a provider's alt text.
const TOOL_VERSION = "1.0.0";

/** Ceiling on one inspected image. Same bound the visual-pattern ingestion uses; well under the model's inline-data limit. */
const MAX_IMAGE_BYTES = 4_000_000;

/** Image content-types forwarded to the vision model. Anything else is reported unreadable rather than guessed at. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export const InspectImagesInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Every `path` below must resolve inside it, under the media cache."),
  images: z
    .array(
      z.object({
        ref: z.string().min(1).describe("Caller's own handle for this image, echoed back on its analysis so results can be matched without relying on order."),
        path: z.string().min(1).optional().describe("Repo-relative path inside repoRoot: a .media-cache/ candidate, a client upload, or a rendered slide PNG."),
        url: z.string().url().optional().describe("An https:// image URL, fetched directly. Exactly one of path/url is required."),
      }),
    )
    .min(1)
    .max(12)
    .describe("The images to look at. One vision call covers all of them; twelve is the ceiling because every image travels into that prompt."),
  brief: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What the post needs the image to show or say. When present, every analysis also carries fitsBrief/fitScore/fitReason judged against it.",
    ),
  purpose: z
    .enum(["attached-media", "candidate-vetting"])
    .default("candidate-vetting")
    .describe(
      "attached-media: the client uploaded this and the copy will be written TO it, so describe generously and suggest an angle. candidate-vetting: a sourced candidate competing for a slot, so judge it against the brief.",
    ),
});
export type InspectImagesInput = z.input<typeof InspectImagesInputSchema>;

/** What the vision model says about one image. Every field is the model's reading, never inferred from provider metadata. */
export interface ImageInspection {
  ref: string;
  /** One or two sentences a copywriter can write to. */
  description: string;
  /** The concrete things in frame: "laptop", "conference stage", "bar chart". */
  subjects: string[];
  /** Legible text in the image, transcribed. Empty when there is none. */
  textInImage: string[];
  mood: string;
  hasPeople: boolean;
  /** A UI capture, article page, chart or document rather than a photograph. */
  looksLikeScreenshot: boolean;
  hasWatermark: boolean;
  /** The tells of synthetic imagery: waxy skin, impossible geometry, garbled lettering, glossy render look. */
  looksAiGenerated: boolean;
  quality: "usable" | "weak" | "unusable";
  qualityReason: string;
  /** Present only when a `brief` was supplied. */
  fitsBrief?: boolean;
  /** 0 (contradicts the brief) to 5 (exactly what the brief asked for). Present only when a `brief` was supplied. */
  fitScore?: number;
  fitReason?: string;
  /** For attached media: the angle the copy should take so the words and the picture tell one story. */
  suggestedAngle?: string;
}

export interface InspectImagesResult {
  inspections: ImageInspection[];
  /** Images the model never saw, with the reason. Never silently dropped. */
  unreadable: { ref: string; reason: string }[];
  model: string;
}

const InspectionResponseSchema = z.object({
  images: z
    .array(
      z.object({
        ref: z.string().min(1),
        description: z.string().min(1),
        subjects: z.array(z.string()).default([]),
        textInImage: z.array(z.string()).default([]),
        mood: z.string().default(""),
        hasPeople: z.boolean().default(false),
        looksLikeScreenshot: z.boolean().default(false),
        hasWatermark: z.boolean().default(false),
        looksAiGenerated: z.boolean().default(false),
        quality: z.enum(["usable", "weak", "unusable"]).default("usable"),
        qualityReason: z.string().default(""),
        fitsBrief: z.boolean().optional(),
        fitScore: z.number().min(0).max(5).optional(),
        fitReason: z.string().optional(),
        suggestedAngle: z.string().optional(),
      }),
    )
    .min(1),
});

function buildInstructions(input: z.output<typeof InspectImagesInputSchema>, shown: string[]): string {
  const lines = [
    input.purpose === "attached-media"
      ? "A client attached these images to a social post they are about to publish. Describe each one the way a copywriter needs it described, so the words can be written TO the picture."
      : "These are candidate images for one social post. Describe each one honestly and judge whether it can be used.",
    "",
    "For every image report, in JSON only:",
    "- description: one or two plain sentences of what is actually in frame. Never guess at what is out of frame.",
    "- subjects: the concrete things visible (objects, places, charts, UI), 2-6 short nouns.",
    "- textInImage: every legible word or number, transcribed. An empty list when there is none.",
    "- mood: a few words (calm, urgent, celebratory, clinical ...).",
    "- hasPeople: whether identifiable people are visible.",
    "- looksLikeScreenshot: true for a UI capture, a web page, a document, a chart or a slide rather than a photograph.",
    "- hasWatermark: true for any stock-site overlay, logo stamp or copyright text.",
    "- looksAiGenerated: true when the image shows the tells of synthetic imagery (waxy skin, impossible geometry, garbled lettering, glossy render sheen).",
    "- quality: usable | weak | unusable, with qualityReason. Unusable means it would embarrass the account: blurry, watermarked, a cookie banner, a blank page, or mostly text the post already says.",
  ];
  if (input.brief) {
    lines.push(
      "",
      `THE BRIEF this post needs the image for: "${input.brief}"`,
      "- fitsBrief: true only when the image shows the brief's actual subject and nothing in it contradicts the post's claim.",
      "- fitScore: 0 (contradicts) to 5 (exactly what was asked for). Judge the CENTRAL subject; a decorative mismatch (time of day, framing, expression) costs at most one point.",
      "- fitReason: one sentence naming what matched or did not.",
    );
  }
  if (input.purpose === "attached-media") {
    lines.push("", "- suggestedAngle: one sentence on the angle the post should take so the text and this picture tell one story.");
  }
  lines.push(
    "",
    "Respond with exactly this shape and nothing else:",
    '{"images": [{"ref": "...", "description": "...", "subjects": [], "textInImage": [], "mood": "...", "hasPeople": false, "looksLikeScreenshot": false, "hasWatermark": false, "looksAiGenerated": false, "quality": "usable", "qualityReason": "...", "fitsBrief": true, "fitScore": 4, "fitReason": "...", "suggestedAngle": "..."}]}',
    "",
    `The images follow, each introduced by its ref. Refs in order: ${shown.join(", ")}.`,
  );
  return lines.join("\n");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

async function readLocalImage(repoRoot: string, relative: string): Promise<{ data: string; mimeType: string } | { error: string }> {
  const rootResolved = path.resolve(repoRoot);
  const abs = path.resolve(repoRoot, relative);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return { error: "path escapes repoRoot" };
  }
  // Any image INSIDE repoRoot: a `.media-cache/` candidate, a client upload,
  // or a rendered slide PNG in the renderer's outDir. The bounds check above
  // is the guarantee; a narrower prefix rule would keep the vision step from
  // ever seeing the pixels the carousel actually shipped.
  const mimeType = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (mimeType === undefined) return { error: `unsupported image extension "${path.extname(abs)}"` };
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(abs);
  } catch (error) {
    return { error: `could not read the file: ${(error as Error).message}` };
  }
  if (bytes.byteLength === 0) return { error: "the file is empty" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: `the file is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES} byte inspection ceiling` };
  return { data: bytes.toString("base64"), mimeType };
}

async function fetchRemoteImage(fetchImpl: typeof fetch, url: string): Promise<{ data: string; mimeType: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    return { error: `fetch failed: ${(error as Error).message}` };
  }
  if (!response.ok) return { error: `fetch returned ${response.status}` };
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!Object.values(IMAGE_TYPES).includes(mimeType)) return { error: `content-type "${mimeType}" is not an inspectable image` };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { error: `could not read the body: ${(error as Error).message}` };
  }
  if (bytes.byteLength === 0) return { error: "the response body is empty" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: `the image is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES} byte inspection ceiling` };
  return { data: bytes.toString("base64"), mimeType };
}

/**
 * `media.inspectImages` — a vision model looks at real pixels and reports
 * what is there.
 *
 * ## Why this exists
 *
 * Every image decision in this engine used to be made from TEXT: a stock
 * provider's alt string, or a licence line the pipeline itself wrote. The
 * Instagram vetting agent's own prompt says as much ("a short written
 * description standing in for actually looking at the image"). Two things
 * were impossible under that rule, and both are things a client notices
 * first: writing a post TO a picture the client uploaded (nobody had read
 * the picture), and rejecting a candidate for a watermark or a cookie banner
 * that the alt text never mentioned.
 *
 * ## What it deliberately is not
 *
 * It does not choose. A caller with a brief gets a fit score per image and
 * makes the selection itself, in code or in its own vetting step, where the
 * decision is recorded. Folding the choice in here would move a judgment a
 * reviewer should be able to see into an opaque ranking.
 *
 * One call for the whole batch, on Gemini 2.5 Flash on Vertex: multimodal,
 * cheap, and the same credential `image.generate` already holds. Unconfigured
 * it reports `not_available`, like every other capability in this package.
 */
export function createInspectImages(options: { client?: VisionAnalysisClient | undefined; model?: string; fetchImpl?: typeof fetch }) {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<InspectImagesInput, InspectImagesResult>({
    name: "media.inspectImages",
    description:
      "A vision model reads up to twelve images (cached files or https URLs) and reports, per image, what is in frame, legible text, mood, watermark/screenshot/AI-generated tells, a usability grade and, when a brief is supplied, how well it fits. Judgment material for the caller — it never selects. Reports not_available when no vision backend is configured.",
    version: TOOL_VERSION,
    inputSchema: InspectImagesInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof InspectImagesInputSchema>;
      if (options.client === undefined) {
        return notAvailable(
          "media.inspectImages: no vision backend configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) so Vertex can be reached",
        );
      }

      const parts: VisionPart[] = [];
      const shown: string[] = [];
      const unreadable: InspectImagesResult["unreadable"] = [];
      const imageParts: Array<{ ref: string; part: VisionPart }> = [];

      for (const image of input.images) {
        if ((image.path === undefined) === (image.url === undefined)) {
          unreadable.push({ ref: image.ref, reason: "exactly one of path or url must be given" });
          continue;
        }
        const loaded = image.path !== undefined ? await readLocalImage(input.repoRoot, image.path) : await fetchRemoteImage(fetchImpl, image.url!);
        if ("error" in loaded) {
          unreadable.push({ ref: image.ref, reason: loaded.error });
          continue;
        }
        shown.push(image.ref);
        imageParts.push({ ref: image.ref, part: { inlineData: { data: loaded.data, mimeType: loaded.mimeType } } });
      }

      if (imageParts.length === 0) {
        return contentFail(
          `media.inspectImages: none of the ${input.images.length} image(s) could be read — ${unreadable.map((u) => `${u.ref} (${u.reason})`).join("; ")}`,
        );
      }

      parts.push({ text: buildInstructions(input, shown) });
      for (const { ref, part } of imageParts) {
        parts.push({ text: `Image ref: ${ref}` });
        parts.push(part);
      }

      let responseText: string | undefined;
      let promptTokens = 0;
      let outputTokens = 0;
      try {
        const response = await options.client.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json" },
        });
        promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
        outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
        if (response.promptFeedback?.blockReason) {
          return contentFail(`media.inspectImages: the vision model blocked the analysis (${response.promptFeedback.blockReason})`);
        }
        responseText = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? undefined;
      } catch (error) {
        return toolingError(`media.inspectImages: the vision model call failed — ${(error as Error).message}`);
      }

      if (responseText === undefined || responseText.trim().length === 0) {
        return contentFail("media.inspectImages: the vision model returned no text");
      }

      let parsed: z.infer<typeof InspectionResponseSchema>;
      try {
        parsed = InspectionResponseSchema.parse(JSON.parse(stripCodeFence(responseText)));
      } catch (error) {
        return contentFail(`media.inspectImages: the vision model's analysis did not parse as the requested JSON shape — ${(error as Error).message}`);
      }

      // Only refs the caller actually sent, so a model that invents an entry
      // cannot smuggle a phantom image into a selection.
      const wanted = new Set(shown);
      const inspections: ImageInspection[] = parsed.images
        .filter((i) => wanted.has(i.ref))
        .map((i) => ({
          ref: i.ref,
          description: i.description,
          subjects: i.subjects,
          textInImage: i.textInImage,
          mood: i.mood,
          hasPeople: i.hasPeople,
          looksLikeScreenshot: i.looksLikeScreenshot,
          hasWatermark: i.hasWatermark,
          looksAiGenerated: i.looksAiGenerated,
          quality: i.quality,
          qualityReason: i.qualityReason,
          ...(i.fitsBrief !== undefined ? { fitsBrief: i.fitsBrief } : {}),
          ...(i.fitScore !== undefined ? { fitScore: i.fitScore } : {}),
          ...(i.fitReason !== undefined ? { fitReason: i.fitReason } : {}),
          ...(i.suggestedAngle !== undefined ? { suggestedAngle: i.suggestedAngle } : {}),
        }));
      for (const ref of shown) {
        if (!inspections.some((i) => i.ref === ref)) unreadable.push({ ref, reason: "the vision model returned no analysis for this image" });
      }
      if (inspections.length === 0) {
        return contentFail("media.inspectImages: the vision model answered, but for none of the images it was shown");
      }

      // The same two per-token SKUs `media.ingestVisualPatterns` bills against
      // — real captured counts, never an estimate.
      return success<InspectImagesResult>({ inspections, unreadable, model }, [
        { model: "gemini-2.5-flash-vision-analysis-input-token", unit: "input-token", quantity: promptTokens },
        { model: "gemini-2.5-flash-vision-analysis-output-token", unit: "output-token", quantity: outputTokens },
      ]);
    },
  });
}
