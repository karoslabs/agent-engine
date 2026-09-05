import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * SCRUM-325 (AU44): the prompt-registry / latest.md-drift check's own
 * regression test.
 *
 * Lives in this package for the same reason the other repo-root guards
 * (config-inventory, dist-freshness, dockerignore) do: it is the one
 * workspace whose suite already asserts on repo-level files.
 *
 * Two halves, and both are load-bearing:
 *
 *  - `it("the repo itself is clean")` is the check running against real
 *    `agents/`. On the commit BEFORE this ticket it failed with two
 *    `latest-drift` problems (`blog-craft`, `newsletter-craft`), because
 *    those two `latest.md` files matched none of their numbered versions and
 *    `publish-prompts.ts` was synthesizing a phantom `v4` from them.
 *
 *  - every `injects ...` case takes a COPY of the real tree, breaks exactly
 *    one thing, and asserts the check notices. Without these, a check that
 *    reports "0 problems" is indistinguishable from a check that cannot
 *    report anything — the failure mode this repo keeps finding. Each case
 *    below is a demonstration that this one is not that.
 */

interface Problem {
  kind: string;
  promptId: string;
  detail: string;
}
interface CheckResult {
  promptCount: number;
  problems: Problem[];
}

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `scripts/check-prompts.ts --json` against `root`. Returns the parsed
 * result AND the process exit status, because "CI fails on drift" is a claim
 * about the exit code, not only about the JSON.
 */
function runCheck(root: string): { result: CheckResult; exitCode: number } {
  let stdout: string;
  let exitCode = 0;
  try {
    stdout = execFileSync("npx", ["tsx", "scripts/check-prompts.ts", "--json", "--root", root], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    exitCode = e.status ?? 1;
    stdout = e.stdout ?? "";
  }
  return { result: JSON.parse(stdout) as CheckResult, exitCode };
}

/**
 * A copy of the parts of the repo the check reads — `agents/` (prompts and
 * the `src/` the pin scan walks) and the gates registry it re-parses. Copying
 * the real tree rather than hand-building a fixture keeps every case honest:
 * the only difference from a passing run is the one thing the case breaks.
 */
function fixtureRoot(mutate: (root: string) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prompt-registry-"));
  tempRoots.push(dir);
  cpSync(path.join(repoRoot, "agents"), path.join(dir, "agents"), { recursive: true });
  const gatesDir = path.join(dir, "packages", "tools", "karos-gates", "src");
  mkdirSync(gatesDir, { recursive: true });
  cpSync(path.join(repoRoot, "packages", "tools", "karos-gates", "src", "index.ts"), path.join(gatesDir, "index.ts"));
  mutate(dir);
  return dir;
}

const promptFile = (root: string, agent: string, promptId: string, file: string): string =>
  path.join(root, "agents", agent, "prompts", promptId, file);

/**
 * Explicit timeout, matching the precedent runs.test.ts set for the three
 * whole-workflow HTTP tests: every case in this file shells out to
 * `npx tsx scripts/check-prompts.ts`, which type-strips and runs a script that walks the whole
 * repo. That is 3-8s of real work on a quiet machine and more under load, against
 * vitest's 5s default — green in isolation, red the moment the rest of this
 * workspace's suite runs alongside it, which is the worst failure shape there is.
 *
 * SCRUM-296 landed a second file in this workspace doing the same thing
 * (tool-version-drift.test.ts), so the two now contend for the machine and both
 * tipped over at once.
 *
 * Declared on the describe rather than raising the global: these are legitimately
 * slow and should say so here, while a genuinely hung 5s unit test elsewhere in
 * this workspace still fails fast.
 */
describe("SCRUM-325: prompt registry and latest.md drift", { timeout: 120_000 }, () => {
  it("the repo itself is clean — registry, latest.md, hygiene and every pin agree", () => {
    const { result, exitCode } = runCheck(repoRoot);
    expect(result.problems, JSON.stringify(result.problems, null, 2)).toEqual([]);
    expect(exitCode).toBe(0);
    expect(result.promptCount).toBeGreaterThan(0);
  });

  it("injects latest.md drift — the exact defect this ticket fixed — and fails", () => {
    // Reproduces the pre-fix state of blog-craft: latest.md edited away from
    // the version the registry calls latest. This is what publish-prompts.ts
    // used to turn into a phantom new version.
    const root = fixtureRoot((r) => {
      const latest = promptFile(r, "blog-agent", "blog-craft", "latest.md");
      writeFileSync(latest, `${readFileSync(latest, "utf8")}\n\nAn un-versioned edit nobody snapshotted.\n`);
    });
    const { result, exitCode } = runCheck(root);
    const drift = result.problems.filter((p) => p.kind === "latest-drift");
    expect(drift.map((p) => p.promptId)).toContain("blog-craft");
    expect(drift[0]?.detail).toContain("matches NO numbered version at all");
    expect(exitCode).toBe(1);
  });

  it("injects a latest.md frozen at an older version and fails", () => {
    // The weaker "latest.md matches SOME numbered version" rule would pass
    // this. It is still drift: latest resolves to v1 while v4 ships.
    const root = fixtureRoot((r) => {
      const dir = path.dirname(promptFile(r, "x-agent", "x-craft", "latest.md"));
      cpSync(path.join(dir, "1.md"), path.join(dir, "latest.md"));
    });
    const { result, exitCode } = runCheck(root);
    const drift = result.problems.filter((p) => p.kind === "latest-drift" && p.promptId === "x-craft");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.detail).toContain("it matches 1.md instead");
    expect(exitCode).toBe(1);
  });

  it("injects a prompt version present on disk but absent from the registry and fails", () => {
    const root = fixtureRoot((r) => {
      const dir = path.dirname(promptFile(r, "tiktok-agent", "tiktok-moment", "latest.md"));
      cpSync(path.join(dir, "1.md"), path.join(dir, "2.md"));
    });
    const { result, exitCode } = runCheck(root);
    const mismatch = result.problems.filter((p) => p.kind === "registry-version-mismatch" && p.promptId === "tiktok-moment");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.detail).toContain("present but undeclared: 2");
    expect(exitCode).toBe(1);
  });

  it("injects a whole new prompt directory the registry never declared and fails", () => {
    const root = fixtureRoot((r) => {
      const dir = path.join(r, "agents", "tiktok-agent", "prompts", "tiktok-smuggled");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "1.md"), "# Smuggled\n");
      writeFileSync(path.join(dir, "latest.md"), "# Smuggled\n");
    });
    const { result, exitCode } = runCheck(root);
    expect(result.problems.map((p) => `${p.kind}:${p.promptId}`)).toContain("registry-missing-prompt:tiktok-smuggled");
    expect(exitCode).toBe(1);
  });

  it("injects a deleted prompt the registry still declares and fails", () => {
    const root = fixtureRoot((r) => {
      rmSync(path.join(r, "agents", "seo-geo-agent", "prompts", "seo-geo-narrative"), { recursive: true, force: true });
    });
    const { result, exitCode } = runCheck(root);
    expect(result.problems.map((p) => `${p.kind}:${p.promptId}`)).toContain("registry-orphan-prompt:seo-geo-narrative");
    expect(exitCode).toBe(1);
  });

  it("injects a missing latest.md and fails", () => {
    const root = fixtureRoot((r) => {
      unlinkSync(promptFile(r, "reddit-agent", "reddit-craft", "latest.md"));
    });
    const { result, exitCode } = runCheck(root);
    expect(result.problems.map((p) => `${p.kind}:${p.promptId}`)).toContain("latest-missing:reddit-craft");
    expect(exitCode).toBe(1);
  });

  describe("per-prompt hygiene", () => {
    it("fails when AU31's language directive is stripped from a prompt declared to carry it", () => {
      const root = fixtureRoot((r) => {
        for (const file of ["5.md", "latest.md"]) {
          const p = promptFile(r, "newsletter-agent", "newsletter-craft", file);
          writeFileSync(p, readFileSync(p, "utf8").replaceAll("clientVoiceContext", "someOtherField"));
        }
      });
      const { result, exitCode } = runCheck(root);
      const hits = result.problems.filter((p) => p.kind === "hygiene-missing-marker" && p.promptId === "newsletter-craft");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.detail).toContain("language directive");
      expect(exitCode).toBe(1);
    });

    it("fails when a prompt says 'never invent numbers' but stops naming gate.numbersSourced", () => {
      const root = fixtureRoot((r) => {
        for (const file of ["5.md", "latest.md"]) {
          const p = promptFile(r, "linkedin-agent", "linkedin-craft", file);
          writeFileSync(p, readFileSync(p, "utf8").replaceAll("gate.numbersSourced", "the sourcing check"));
        }
      });
      const { result, exitCode } = runCheck(root);
      const hits = result.problems.filter((p) => p.kind === "hygiene-missing-marker" && p.promptId === "linkedin-craft");
      expect(hits.map((h) => h.detail).join(" ")).toContain("never names `gate.numbersSourced`");
      expect(exitCode).toBe(1);
    });

    it("fails when a required structured-output field disappears from the prompt", () => {
      const root = fixtureRoot((r) => {
        for (const file of ["4.md", "latest.md"]) {
          const p = promptFile(r, "blog-agent", "blog-craft", file);
          writeFileSync(p, readFileSync(p, "utf8").replaceAll("faqItems", "theFaqBlock"));
        }
      });
      const { result, exitCode } = runCheck(root);
      const hits = result.problems.filter((p) => p.kind === "hygiene-missing-marker" && p.promptId === "blog-craft");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.detail).toContain("faqItems");
      expect(exitCode).toBe(1);
    });

    it("fails when a prompt instructs the model to satisfy a gate that does not exist", () => {
      const root = fixtureRoot((r) => {
        const p = promptFile(r, "x-agent", "x-craft", "4.md");
        writeFileSync(p, `${readFileSync(p, "utf8")}\n\nYour draft must also pass \`gate.vibeCheck\`.\n`);
      });
      const { result, exitCode } = runCheck(root);
      const hits = result.problems.filter((p) => p.kind === "unknown-gate");
      expect(hits.map((h) => h.detail).join(" ")).toContain("gate.vibeCheck");
      expect(exitCode).toBe(1);
    });

    it("fails when the hard-coded KNOWN_GATES list drifts from createKarosGatesTools()", () => {
      // KNOWN_GATES is a literal so the check can run before `npm run build`.
      // A literal that nothing cross-checks is a list that silently rots, so
      // the check re-parses the real registration site — this proves it does.
      const root = fixtureRoot((r) => {
        const p = path.join(r, "packages", "tools", "karos-gates", "src", "index.ts");
        writeFileSync(p, readFileSync(p, "utf8").replace('"gate.leakCheck": leakCheck,', '"gate.leakCheckV2": leakCheck,'));
      });
      const { result, exitCode } = runCheck(root);
      const hits = result.problems.filter((p) => p.promptId === "(karos-gates)");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.detail).toContain("gate.leakCheckV2");
      expect(exitCode).toBe(1);
    });
  });

  it("injects a skillRef pinned to a version the registry does not declare and fails", () => {
    const root = fixtureRoot((r) => {
      const p = path.join(r, "agents", "x-agent", "src", "agent", "x-draft-agent.ts");
      writeFileSync(p, readFileSync(p, "utf8").replace('skillRef: "x-craft@5"', 'skillRef: "x-craft@9"'));
    });
    const { result, exitCode } = runCheck(root);
    const hits = result.problems.filter((p) => p.kind === "unresolvable-pin" && p.promptId === "x-craft");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.detail).toContain('"x-craft@9"');
    expect(exitCode).toBe(1);
  });

  it("ignores the deliberate nonsense skillRefs in __tests__ and evals", () => {
    // Those exist to exercise the "agent fails gracefully on an unresolvable
    // skillRef" path. If the pin scan ever picked them up, the check would be
    // permanently red and get switched off.
    const root = fixtureRoot((r) => {
      const dir = path.join(r, "agents", "x-agent", "__tests__");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "nonsense.test.ts"), 'export const cfg = { skillRef: "does-not-exist@99" };\n');
    });
    const { result, exitCode } = runCheck(root);
    expect(result.problems).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
