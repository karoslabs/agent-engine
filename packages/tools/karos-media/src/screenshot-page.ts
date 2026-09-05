import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX, type FindImagesCandidate } from "./find-images.js";

// 1.0.0 — new: a real screenshot of the page a post reacts to.
const TOOL_VERSION = "1.0.0";

export const ScreenshotPageInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The returned path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as the other media tools do."),
  url: z.string().url().describe("The page to capture — the source article a post cites, a product page, a changelog."),
  title: z.string().min(1).optional().describe("The page's headline, carried into the candidate description for the reviewer."),
  viewport: z
    .object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(320).max(2560) })
    .default({ width: 1200, height: 675 })
    .describe("Capture size. 1200x675 is X's 16:9 card; 1200x1200 suits LinkedIn's square preview."),
  timeoutMs: z.number().int().min(5_000).max(90_000).default(30_000).describe("Navigation ceiling. A page that has not settled by then is captured as it stands."),
});
export type ScreenshotPageInput = z.input<typeof ScreenshotPageInputSchema>;

export interface ScreenshotPageResult {
  candidate: FindImagesCandidate & { sourceUrl: string; sourceTitle?: string };
  /** The page's `<title>` as rendered, when the browser could read one. */
  pageTitle?: string;
}

/** The narrow slice of a Playwright browser this tool drives — injectable so tests never launch Chromium. */
export interface BrowserLike {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PageLike>;
  close(): Promise<void>;
}
export interface PageLike {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  screenshot(options?: { type?: "png"; fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}
export type BrowserLauncher = () => Promise<BrowserLike>;

/** The licence line on a page capture. Same footing as a harvested article image, stated the same way. */
export const SCREENSHOT_LICENCE =
  "SCREENSHOT of a third-party page: usable only as a credited reference in a post that links to that page, never as the client's own creative and never in paid promotion";

/**
 * Launches Playwright's Chromium, the same way `publish.renderCarousel` does:
 * a dynamic import so a deployment without the browser fails per call with
 * a reason, never at module load.
 */
async function launchPlaywright(): Promise<BrowserLike> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  return {
    async newPage(options) {
      const page = await browser.newPage(options?.viewport ? { viewport: options.viewport } : {});
      return {
        goto: (url, gotoOptions) => page.goto(url, gotoOptions),
        title: () => page.title(),
        screenshot: (screenshotOptions) => page.screenshot({ type: "png", ...(screenshotOptions?.fullPage !== undefined ? { fullPage: screenshotOptions.fullPage } : {}) }),
        close: () => page.close(),
      };
    },
    close: () => browser.close(),
  };
}

/**
 * `media.screenshotPage` — the picture X actually rewards.
 *
 * ## Why a screenshot tier
 *
 * On X, a post reacting to news travels furthest with the artefact itself:
 * the headline as it ran, the pricing table, the changelog entry, the chart.
 * A stock photo of "a person reading news" is the illustration every craft
 * guide in this repo tells the writer to avoid. This tool captures the
 * above-the-fold view of the cited page at card size, so the post can show
 * what it is talking about.
 *
 * Provenance is `unknown`, deliberately, on the same footing as a harvested
 * article image: the page is someone else's, the post links to it, and the
 * human gate decides. A caller wanting an unattended publish should not lean
 * on this tier.
 *
 * Chromium is the same Playwright the carousel renderer already ships in the
 * container; `launcher` is injectable so tests never open a browser.
 * Unconfigured (`launcher: null`) it reports `not_available`.
 */
export function createScreenshotPage(options: { launcher?: BrowserLauncher | null | undefined }) {
  const launcher: BrowserLauncher | undefined = options.launcher === null ? undefined : (options.launcher ?? launchPlaywright);

  return defineTool<ScreenshotPageInput, ScreenshotPageResult>({
    name: "media.screenshotPage",
    description:
      "Captures the above-the-fold view of a page (the cited article, a product page, a changelog) at social-card size with headless Chromium and stores it in the run's media cache. Third-party page: licenseConfidence unknown, carries the source URL for a credit line. Reports not_available when no browser launcher is configured.",
    version: TOOL_VERSION,
    inputSchema: ScreenshotPageInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof ScreenshotPageInputSchema>;
      if (launcher === undefined) {
        return notAvailable("media.screenshotPage: no browser launcher configured for this deployment");
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.screenshotPage: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.screenshotPage: could not create ${relDir}: ${(error as Error).message}`);
      }

      let browser: BrowserLike;
      try {
        browser = await launcher();
      } catch (error) {
        return toolingError(`media.screenshotPage: could not launch a browser — ${(error as Error).message}`);
      }

      let bytes: Buffer;
      let pageTitle: string | undefined;
      try {
        const page = await browser.newPage({ viewport: input.viewport });
        try {
          // `domcontentloaded` then a bounded settle: `networkidle` never fires
          // on pages with analytics beacons, and a headline is legible long
          // before the last tracker answers.
          await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
          pageTitle = (await page.title().catch(() => "")) || undefined;
          bytes = await page.screenshot({ type: "png", fullPage: false });
        } finally {
          await page.close().catch(() => undefined);
        }
      } catch (error) {
        await browser.close().catch(() => undefined);
        return contentFail(`media.screenshotPage: could not capture ${input.url} — ${(error as Error).message}`);
      }
      await browser.close().catch(() => undefined);

      if (bytes.byteLength === 0) {
        return contentFail(`media.screenshotPage: the capture of ${input.url} was empty`);
      }

      const stem = `screenshot-${createHash("sha1").update(input.url).digest("hex").slice(0, 12)}`;
      const relative = `${relDir}/${stem}.png`;
      try {
        await fs.writeFile(path.join(absDir, `${stem}.png`), bytes);
      } catch (error) {
        return toolingError(`media.screenshotPage: could not write the capture: ${(error as Error).message}`);
      }

      const title = input.title ?? pageTitle;
      return success<ScreenshotPageResult>({
        candidate: {
          path: relative,
          description:
            `screenshot of${title ? ` "${title}"` : " the page"} at ${input.url}, captured ${new Date().toISOString().slice(0, 10)} at ${input.viewport.width}x${input.viewport.height}. [licence: ${SCREENSHOT_LICENCE}]`,
          provider: "screenshot",
          licenseConfidence: "unknown",
          sourceUrl: input.url,
          ...(title !== undefined ? { sourceTitle: title } : {}),
        },
        ...(pageTitle !== undefined ? { pageTitle } : {}),
      });
    },
  });
}
