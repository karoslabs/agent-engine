import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError, notAvailable, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.0.0 — new: the hand-off from the run's media cache to a URL a reviewer can open.
const TOOL_VERSION = "1.0.0";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

export const StageAssetInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. `path` must resolve inside it, under the media cache."),
  path: z.string().min(1).describe("Repo-relative path under .media-cache/, as the sourcing tools return it."),
  objectPath: z.string().min(1).optional().describe("Destination object path in the media bucket. Defaults to agent-engine/<runId-derived>/<filename>."),
  runId: z.string().min(1).describe("Used to build the default objectPath, so two runs never overwrite each other's asset."),
});
export type StageAssetInput = z.input<typeof StageAssetInputSchema>;

export interface StageAssetResult {
  /** A signed https URL when signing succeeded, else the gs:// URI. The portal re-hosts only an https URL. */
  url: string;
  gcsUri: string;
  contentType: string;
  bytes: number;
}

/**
 * `media.stageAsset` — puts one cached media file where a reviewer (and the
 * portal) can fetch it.
 *
 * ## Why this is its own tool
 *
 * Every sourcing tier in this package writes to `.media-cache/<runId>/` on the
 * worker's own disk, which is exactly right for the renderer that reads it
 * next and exactly useless for a LinkedIn or X deliverable: nothing renders
 * those, so the picture had no way off the machine. `publish.renderCarousel`
 * solved this for Instagram by uploading its PNGs through the GCS media store
 * and returning a signed URL, which karosCMO's materializer then re-hosts
 * (it refuses anything that is not an https URL, loudly). This is the same
 * hand-off for an image that was chosen rather than rendered.
 *
 * Unconfigured (no media store) it reports `not_available`, and a caller
 * keeps the local path for the trace.
 */
export function createStageAsset(options: { mediaStore?: GcsArtifactStoreLike | undefined }) {
  return defineTool<StageAssetInput, StageAssetResult>({
    name: "media.stageAsset",
    description:
      "Uploads one file from the run's media cache to the GCS media store and returns a fetchable URL (signed https when available, else the gs:// URI) — the hand-off that lets a chosen image reach a deliverable and the portal. Reports not_available when no media store is configured.",
    version: TOOL_VERSION,
    inputSchema: StageAssetInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof StageAssetInputSchema>;
      if (options.mediaStore === undefined) {
        return notAvailable("media.stageAsset: no media store configured — set GCS_MEDIA_BUCKET so chosen images can be staged for review");
      }

      const rootResolved = path.resolve(input.repoRoot);
      const abs = path.resolve(input.repoRoot, input.path);
      if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.stageAsset: path escapes repoRoot ("${input.path}")`);
      }
      if (!input.path.replace(/\\/g, "/").startsWith(`${MEDIA_CACHE_PREFIX}/`)) {
        return toolingError(`media.stageAsset: only files under ${MEDIA_CACHE_PREFIX}/ are staged ("${input.path}")`);
      }
      const extension = path.extname(abs).toLowerCase();
      const contentType = CONTENT_TYPES[extension];
      if (contentType === undefined) {
        return toolingError(`media.stageAsset: unsupported file type "${extension}"`);
      }

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(abs);
      } catch (error) {
        return toolingError(`media.stageAsset: could not read ${input.path}: ${(error as Error).message}`);
      }
      if (bytes.byteLength === 0) return toolingError(`media.stageAsset: ${input.path} is empty`);

      const objectPath = input.objectPath ?? `agent-engine/${input.runId}/${path.basename(abs)}`;
      try {
        const { gcsUri, signedUrl } = await options.mediaStore.upload(objectPath, bytes, { contentType });
        return success<StageAssetResult>({ url: signedUrl ?? gcsUri, gcsUri, contentType, bytes: bytes.byteLength });
      } catch (error) {
        return toolingError(`media.stageAsset: upload failed: ${(error as Error).message}`);
      }
    },
  });
}
