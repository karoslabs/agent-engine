import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { ScrapedRecord, ScraperProvider } from "@agent-engine/tool-karos-scraper";
import {
  createKarosMediaTools,
  extractMetaImageUrls,
  type BrowserLike,
  type VisionAnalysisClient,
} from "../src/index.js";

/**
 * The 2026-09 media upgrade: a vision model that looks at pixels
 * (`media.inspectImages`), the cited article's own lead image
 * (`media.harvestArticleImages`), a real screenshot of the cited page
 * (`media.screenshotPage`), and the hand-off from the run's cache to a URL a
 * reviewer can open (`media.stageAsset`).
 *
 * Every test here drives the tool with a fake backend and asserts on what
 * reached the backend and what came back — never on a network.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" } as never;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-media-upgrade-"));
  await fs.mkdir(path.join(repoRoot, ".media-cache", "run_1"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".media-cache", "run_1", "n1-a.png"), Buffer.from(PNG_B64, "base64"));
  await fs.writeFile(path.join(repoRoot, ".media-cache", "run_1", "n1-b.png"), Buffer.from(PNG_B64, "base64"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

function visionClient(answer: unknown, capture?: (req: { model: string; contents: Array<{ parts: unknown[] }> }) => void): VisionAnalysisClient {
  return {
    models: {
      async generateContent(req) {
        capture?.(req as never);
        return {
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }],
          usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 },
        };
      },
    },
  };
}

describe("media.inspectImages", () => {
  it("shows every readable image to the vision model with the brief, and returns one analysis per ref", async () => {
    let seen: { model: string; contents: Array<{ parts: unknown[] }> } | undefined;
    const client = visionClient(
      {
        images: [
          { ref: "a", description: "a bar chart on a laptop screen", subjects: ["chart", "laptop"], textInImage: ["31%"], mood: "clinical", hasPeople: false, looksLikeScreenshot: true, hasWatermark: false, looksAiGenerated: false, quality: "usable", qualityReason: "sharp", fitsBrief: true, fitScore: 5, fitReason: "the chart" },
          { ref: "b", description: "a stock handshake", subjects: ["hands"], textInImage: [], mood: "corporate", hasPeople: true, looksLikeScreenshot: false, hasWatermark: true, looksAiGenerated: false, quality: "unusable", qualityReason: "watermark", fitsBrief: false, fitScore: 1, fitReason: "generic" },
          { ref: "phantom", description: "invented", subjects: [], textInImage: [], mood: "", hasPeople: false, looksLikeScreenshot: false, hasWatermark: false, looksAiGenerated: false, quality: "usable", qualityReason: "" },
        ],
      },
      (req) => {
        seen = req;
      },
    );
    const tool = createKarosMediaTools({ env: {}, visionClient: client, generationClient: null })["media.inspectImages"]!;
    const outcome = await tool.execute(
      { repoRoot, images: [{ ref: "a", path: ".media-cache/run_1/n1-a.png" }, { ref: "b", path: ".media-cache/run_1/n1-b.png" }, { ref: "missing", path: ".media-cache/run_1/nope.png" }], brief: "the launch chart" },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const result = outcome.result as { inspections: Array<{ ref: string; fitScore?: number; hasWatermark: boolean }>; unreadable: Array<{ ref: string }>; model: string };
    // Two images reached the model as inline data, the brief travelled in the instructions.
    expect(seen?.model).toBe("gemini-2.5-flash");
    const inline = seen!.contents[0]!.parts.filter((p) => typeof p === "object" && p !== null && "inlineData" in (p as object));
    expect(inline).toHaveLength(2);
    expect(JSON.stringify(seen!.contents[0]!.parts[0])).toContain("the launch chart");
    // One analysis per ref actually shown; the phantom ref the model invented is dropped, the missing file is reported.
    expect(result.inspections.map((i) => i.ref)).toEqual(["a", "b"]);
    expect(result.inspections[0]!.fitScore).toBe(5);
    expect(result.inspections[1]!.hasWatermark).toBe(true);
    expect(result.unreadable.map((u) => u.ref)).toEqual(["missing"]);
    // Billed at the real captured token counts, on the vision SKUs.
    expect(outcome.usage).toEqual([
      { model: "gemini-2.5-flash-vision-analysis-input-token", unit: "input-token", quantity: 1200 },
      { model: "gemini-2.5-flash-vision-analysis-output-token", unit: "output-token", quantity: 80 },
    ]);
  });

  it("refuses a path that escapes repoRoot or is not an image, and reports not_available with no vision backend", async () => {
    const tool = createKarosMediaTools({ env: {}, visionClient: visionClient({ images: [] }), generationClient: null })["media.inspectImages"]!;
    const outcome = await tool.execute({ repoRoot, images: [{ ref: "x", path: "../outside.png" }, { ref: "y", path: "notes.txt" }] }, { ctx: CTX });
    expect(outcome.status).toBe("content_fail");
    if (outcome.status === "content_fail") expect(outcome.reason).toMatch(/escapes repoRoot[\s\S]*unsupported image extension/);

    const none = createKarosMediaTools({ env: {}, visionClient: null, generationClient: null })["media.inspectImages"]!;
    const unavailable = await none.execute({ repoRoot, images: [{ ref: "a", path: ".media-cache/run_1/n1-a.png" }] }, { ctx: CTX });
    expect(unavailable.status).toBe("not_available");
  });
});

describe("media.harvestArticleImages", () => {
  const pngFetch = (async () =>
    new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

  function scraper(records: Record<string, ScrapedRecord | undefined>, html?: string): ScraperProvider {
    return {
      name: "fake",
      async extractUrl(url) {
        return records[url];
      },
      async fetchRaw(url) {
        return html !== undefined ? { url, html } : undefined;
      },
      async searchKeyword() {
        return [];
      },
      async socialHistory() {
        return [];
      },
      async searchSocial() {
        return [];
      },
    };
  }

  it("downloads the article's lead image, credits the source, and marks provenance unknown", async () => {
    const tool = createKarosMediaTools({
      env: {},
      generationClient: null,
      fetchImpl: pngFetch,
      scraper: scraper({ "https://example.test/launch": { id: "1", url: "https://example.test/launch", title: "The launch", imageUrls: ["https://cdn.example/lead.png"] } }),
    })["media.harvestArticleImages"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", sources: [{ url: "https://example.test/launch" }] }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const result = outcome.result as { candidates: Array<{ path: string; provider: string; licenseConfidence: string; sourceUrl: string; sourceTitle?: string; description: string }> };
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.provider).toBe("article-harvest");
    expect(result.candidates[0]!.licenseConfidence).toBe("unknown");
    expect(result.candidates[0]!.sourceUrl).toBe("https://example.test/launch");
    expect(result.candidates[0]!.sourceTitle).toBe("The launch");
    expect(result.candidates[0]!.description).toMatch(/PUBLISHER-OWNED/);
    expect(result.candidates[0]!.path.startsWith(".media-cache/run_1/")).toBe(true);
  });

  it("falls back to og:image / twitter:image meta tags when the scraper's record carries no imageUrls", async () => {
    const html = `<html><head><meta property="og:image" content="https://cdn.example/og.png"><meta name="twitter:image" content="https://cdn.example/og.png"></head></html>`;
    expect(extractMetaImageUrls(html)).toEqual(["https://cdn.example/og.png"]);
    const tool = createKarosMediaTools({
      env: {},
      generationClient: null,
      fetchImpl: pngFetch,
      scraper: scraper({ "https://example.test/a": { id: "1", url: "https://example.test/a" } }, html),
    })["media.harvestArticleImages"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", sources: [{ url: "https://example.test/a", title: "A" }] }, { ctx: CTX });
    expect(outcome.status).toBe("success");
  });

  it("is content_fail (not tooling) when no article exposes a lead image, and not_available without a scraper", async () => {
    const tool = createKarosMediaTools({ env: {}, generationClient: null, fetchImpl: pngFetch, scraper: scraper({ "https://example.test/a": { id: "1", url: "https://example.test/a" } }) })["media.harvestArticleImages"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", sources: [{ url: "https://example.test/a" }] }, { ctx: CTX });
    expect(outcome.status).toBe("content_fail");
    const none = createKarosMediaTools({ env: {}, generationClient: null, scraper: null })["media.harvestArticleImages"]!;
    expect((await none.execute({ repoRoot, runId: "run_1", sources: [{ url: "https://example.test/a" }] }, { ctx: CTX })).status).toBe("not_available");
  });
});

describe("media.screenshotPage", () => {
  it("drives the injected browser at the requested viewport and stores the capture in the run's cache", async () => {
    const calls: string[] = [];
    const browser: BrowserLike = {
      async newPage(options) {
        calls.push(`newPage ${options?.viewport?.width}x${options?.viewport?.height}`);
        return {
          async goto(url) {
            calls.push(`goto ${url}`);
            return undefined;
          },
          async title() {
            return "Launch day";
          },
          async screenshot() {
            return Buffer.from(PNG_B64, "base64");
          },
          async close() {
            calls.push("page.close");
          },
        };
      },
      async close() {
        calls.push("browser.close");
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: null, browserLauncher: async () => browser })["media.screenshotPage"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", url: "https://example.test/launch" }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const result = outcome.result as { candidate: { path: string; provider: string; sourceUrl: string; sourceTitle?: string; description: string }; pageTitle?: string };
    expect(calls).toEqual(["newPage 1200x675", "goto https://example.test/launch", "page.close", "browser.close"]);
    expect(result.candidate.provider).toBe("screenshot");
    expect(result.candidate.sourceTitle).toBe("Launch day");
    expect(result.candidate.description).toMatch(/SCREENSHOT of a third-party page/);
    await expect(fs.stat(path.join(repoRoot, result.candidate.path))).resolves.toBeDefined();
  });

  it("reports not_available when the launcher is disabled, and content_fail when the page cannot be captured", async () => {
    const none = createKarosMediaTools({ env: {}, generationClient: null, browserLauncher: null })["media.screenshotPage"]!;
    expect((await none.execute({ repoRoot, runId: "run_1", url: "https://example.test/x" }, { ctx: CTX })).status).toBe("not_available");
    const failing: BrowserLike = {
      async newPage() {
        return {
          async goto() {
            throw new Error("net::ERR_NAME_NOT_RESOLVED");
          },
          async title() {
            return "";
          },
          async screenshot() {
            return Buffer.alloc(0);
          },
          async close() {},
        };
      },
      async close() {},
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: null, browserLauncher: async () => failing })["media.screenshotPage"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", url: "https://example.test/x" }, { ctx: CTX });
    expect(outcome.status).toBe("content_fail");
  });
});

describe("media.stageAsset", () => {
  it("uploads a cached file through the media store and returns the signed URL", async () => {
    const uploads: Array<{ objectPath: string; contentType?: string | undefined; bytes: number }> = [];
    const store: GcsArtifactStoreLike = {
      bucketName: "media",
      async upload(objectPath, data, options) {
        uploads.push({ objectPath, contentType: options?.contentType, bytes: data.byteLength });
        return { objectPath, gcsUri: `gs://media/${objectPath}`, signedUrl: `https://signed.example/${objectPath}` };
      },
      async download() {
        return Buffer.alloc(0);
      },
      async exists() {
        return true;
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: null, mediaStore: store })["media.stageAsset"]!;
    const outcome = await tool.execute({ repoRoot, runId: "run_1", path: ".media-cache/run_1/n1-a.png" }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const result = outcome.result as { url: string; gcsUri: string; contentType: string; bytes: number };
    expect(result.url).toBe("https://signed.example/agent-engine/run_1/n1-a.png");
    expect(result.gcsUri).toBe("gs://media/agent-engine/run_1/n1-a.png");
    expect(result.contentType).toBe("image/png");
    expect(result.bytes).toBeGreaterThan(0);
    expect(uploads[0]!.contentType).toBe("image/png");
    expect(uploads[0]!.bytes).toBe(result.bytes);
  });

  it("refuses a file outside the media cache, and reports not_available without a store", async () => {
    const store: GcsArtifactStoreLike = { bucketName: "m", async upload() { throw new Error("unreachable"); }, async download() { return Buffer.alloc(0); }, async exists() { return false; } };
    const tool = createKarosMediaTools({ env: {}, generationClient: null, mediaStore: store })["media.stageAsset"]!;
    expect((await tool.execute({ repoRoot, runId: "run_1", path: "package.json" }, { ctx: CTX })).status).toBe("tooling_error");
    const none = createKarosMediaTools({ env: {}, generationClient: null })["media.stageAsset"]!;
    expect((await none.execute({ repoRoot, runId: "run_1", path: ".media-cache/run_1/n1-a.png" }, { ctx: CTX })).status).toBe("not_available");
  });
});
