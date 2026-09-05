import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { ScraperError, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { MEDIA_CACHE_PREFIX, downloadImage, type FindImagesCandidate } from "./find-images.js";

// 1.0.0 — new: the source articles a post is written FROM as an image source.
const TOOL_VERSION = "1.0.0";

export const HarvestArticleImagesInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Every returned path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as the other media tools do."),
  sources: z
    .array(
      z.object({
        url: z.string().url().describe("The article's URL — the same URL the research step fetched and the draft cites."),
        title: z.string().min(1).optional().describe("The article's headline, carried into the candidate description for the reviewer."),
      }),
    )
    .min(1)
    .max(6)
    .describe("The research documents this post draws on. Each is one scrape."),
  perSource: z.number().int().min(1).max(4).default(2).describe("How many images to keep per article. The lead image is almost always the first."),
});
export type HarvestArticleImagesInput = z.input<typeof HarvestArticleImagesInputSchema>;

/** A `FindImagesCandidate` that also remembers which article it came from, because the credit line depends on it. */
export interface HarvestedImageCandidate extends FindImagesCandidate {
  sourceUrl: string;
  sourceTitle?: string;
}

export interface HarvestArticleImagesResult {
  candidates: HarvestedImageCandidate[];
  unmet: { url: string; reason: string }[];
}

/**
 * The licence line recorded on an image lifted from a source article.
 *
 * Stated bluntly, as `media.scrapeImages` states its own: the publisher (or
 * the photographer they licensed) holds the rights. What makes this tier
 * usable at all is the context the post already has — it is ABOUT this
 * article and links to it — so the image runs as a credited editorial
 * reference, never as the client's own creative and never in a paid
 * placement. The rights gate keeps the final say.
 */
export const PUBLISHER_LICENCE =
  "PUBLISHER-OWNED editorial image from the cited source article: usable only as a credited reference in a post that links to that article, never as the client's own creative and never in paid promotion";

/** `<meta property="og:image" content="...">` and its Twitter twin, in either attribute order. */
const META_IMAGE_PATTERNS = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/gi,
];

/** Pulls the social-card image URLs out of raw HTML, lead image first, de-duplicated. */
export function extractMetaImageUrls(html: string): string[] {
  const found: string[] = [];
  for (const pattern of META_IMAGE_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1]?.trim();
      if (url && /^https?:\/\//i.test(url) && !found.includes(url)) found.push(url);
    }
  }
  return found;
}

/**
 * `media.harvestArticleImages` — the images of the very articles a post is
 * written from.
 *
 * ## Why this tier exists between stock and generation
 *
 * A post reacting to a launch, a funding round or a report is about a REAL,
 * SPECIFIC thing. Stock libraries hold generic scenes of it; generation
 * invents a version of it. The article the research step already fetched
 * carries the actual picture — the product shot, the chart, the stage — as
 * its social-card image, and every publisher puts one there precisely so the
 * story travels with it. For X in particular, where a screenshot or the real
 * artefact outperforms an illustration, this is usually the right picture.
 *
 * Provenance is `unknown` on purpose (see `PUBLISHER_LICENCE`): this tier
 * widens the reviewer's choice with the genuine article, it does not clear
 * rights by itself. A caller that publishes unattended should prefer a
 * client upload or a generated image; a caller with a human gate gets the
 * real thing to approve.
 *
 * Two ways to find the image, in order: the scraper's own `extractUrl`
 * (which normalises `imageUrls` when the vendor returns them), then the raw
 * HTML's `og:image`/`twitter:image` meta tags. Unconfigured (no scraper) it
 * reports `not_available`, like every other credentialed capability here.
 */
export function createHarvestArticleImages(options: { scraper?: ScraperProvider | undefined; fetchImpl?: typeof fetch }) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<HarvestArticleImagesInput, HarvestArticleImagesResult>({
    name: "media.harvestArticleImages",
    description:
      "Downloads the lead/social-card images of the source articles a post cites (via the scraper's extracted imageUrls, then og:image/twitter:image meta tags). Publisher-owned: candidates are licenseConfidence unknown and carry the source URL for a credit line. Reports not_available when no scraper is configured.",
    version: TOOL_VERSION,
    inputSchema: HarvestArticleImagesInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof HarvestArticleImagesInputSchema>;
      if (options.scraper === undefined) {
        return notAvailable("media.harvestArticleImages: no scraper configured — set SCRAPPYCOCO_API_KEY to enable the article-image tier");
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.harvestArticleImages: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.harvestArticleImages: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: HarvestedImageCandidate[] = [];
      const unmet: HarvestArticleImagesResult["unmet"] = [];
      let sawOutage = false;

      for (const [index, source] of input.sources.entries()) {
        let imageUrls: string[] = [];
        let title = source.title;
        try {
          const record = await options.scraper.extractUrl(source.url, { limit: 1 });
          if (record?.imageUrls && record.imageUrls.length > 0) imageUrls = [...record.imageUrls];
          if (title === undefined && record?.title) title = record.title;
          if (imageUrls.length === 0) {
            const raw = await options.scraper.fetchRaw(source.url);
            if (raw?.html) imageUrls = extractMetaImageUrls(raw.html);
            if (title === undefined && raw?.title) title = raw.title;
          }
        } catch (error) {
          if (error instanceof ScraperError) {
            sawOutage = true;
            unmet.push({ url: source.url, reason: `scraper failed: ${error.message}` });
            continue;
          }
          throw error;
        }

        if (imageUrls.length === 0) {
          unmet.push({ url: source.url, reason: "the article exposes no lead image (no imageUrls, no og:image/twitter:image)" });
          continue;
        }

        let saved = 0;
        for (const [imageIndex, imageUrl] of imageUrls.entries()) {
          if (saved >= input.perSource) break;
          const relative = await downloadImage(fetchImpl, { id: `article-${index}-${imageIndex}-${imageUrl}`, url: imageUrl }, absDir, relDir, index + 1);
          if (relative === undefined) continue;
          candidates.push({
            path: relative,
            description:
              `lead image of the cited article${title ? ` "${title}"` : ""} (${source.url})` +
              ` — the publisher's own social-card picture for this story. [licence: ${PUBLISHER_LICENCE}]`,
            provider: "article-harvest",
            licenseConfidence: "unknown",
            sourceUrl: source.url,
            ...(title !== undefined ? { sourceTitle: title } : {}),
          });
          saved += 1;
        }
        if (saved === 0) unmet.push({ url: source.url, reason: `${imageUrls.length} lead image URL(s) found, none downloaded as a usable image` });
      }

      if (candidates.length === 0) {
        if (sawOutage) {
          return toolingError(`media.harvestArticleImages: the scraper failed for every source — ${unmet.map((u) => `${u.url} (${u.reason})`).join("; ")}`);
        }
        return contentFail(`media.harvestArticleImages: none of the ${input.sources.length} article(s) yielded a usable image — ${unmet.map((u) => `${u.url} (${u.reason})`).join("; ")}`);
      }

      return success<HarvestArticleImagesResult>({ candidates, unmet });
    },
  });
}
