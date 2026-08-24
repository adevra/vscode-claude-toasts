import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoColor, findRepoInfo, PALETTE, resolveAccentColor, SessionColorReader } from "./sessionMeta";

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ct-meta-"));
  tmpDirs.push(d);
  return d;
}

function makeRepo(root: string, branch = "main"): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

describe("findRepoInfo", () => {
  it("finds the repo and branch from the root", () => {
    const root = tmp();
    makeRepo(root, "feat/v1-implementation");
    const info = findRepoInfo(root);
    expect(info?.repo).toBe(path.basename(root));
    expect(info?.branch).toBe("feat/v1-implementation");
  });

  it("walks up from a nested cwd", () => {
    const root = tmp();
    makeRepo(root);
    const nested = path.join(root, "src", "deep", "dir");
    fs.mkdirSync(nested, { recursive: true });
    expect(findRepoInfo(nested)?.repo).toBe(path.basename(root));
  });

  it("shows a short hash when HEAD is detached", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\n");
    expect(findRepoInfo(root)?.branch).toBe("a1b2c3d4");
  });

  it("resolves a .git file (worktree) to its gitdir", () => {
    const main = tmp();
    fs.mkdirSync(path.join(main, "gitdir"));
    fs.writeFileSync(path.join(main, "gitdir", "HEAD"), "ref: refs/heads/wt-branch\n");
    const wt = tmp();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, "gitdir")}\n`);
    const info = findRepoInfo(wt);
    expect(info?.repo).toBe(path.basename(wt));
    expect(info?.branch).toBe("wt-branch");
  });

  it("returns null outside any repo and for null cwd", () => {
    expect(findRepoInfo(tmp())).toBeNull();
    expect(findRepoInfo(null)).toBeNull();
  });
});

describe("autoColor", () => {
  it("is stable and stays inside the palette", () => {
    const c = autoColor("vscode-claude-toasts");
    expect(autoColor("vscode-claude-toasts")).toBe(c);
    expect(Object.keys(PALETTE)).toContain(c);
  });

  it("spreads different names across colors", () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
    expect(new Set(names.map(autoColor)).size).toBeGreaterThan(2);
  });
});

describe("SessionColorReader", () => {
  function transcript(lines: string[]): string {
    const f = path.join(tmp(), "t.jsonl");
    fs.writeFileSync(f, lines.map((l) => l + "\n").join(""));
    return f;
  }

  it("reads the /color line", () => {
    const f = transcript([
      '{"type":"user","message":"hi"}',
      '{"type":"agent-color","agentColor":"red","sessionId":"s1"}',
    ]);
    expect(new SessionColorReader().read("s1", f)).toBe("red");
  });

  it("uses the newest color when changed mid-session", () => {
    const f = transcript([
      '{"type":"agent-color","agentColor":"red","sessionId":"s1"}',
      '{"type":"agent-color","agentColor":"blue","sessionId":"s1"}',
    ]);
    expect(new SessionColorReader().read("s1", f)).toBe("blue");
  });

  it("picks up a color appended after the first scan", () => {
    const r = new SessionColorReader();
    const f = transcript(['{"type":"user","message":"hi"}']);
    expect(r.read("s1", f)).toBeNull();
    fs.appendFileSync(f, '{"type":"agent-color","agentColor":"cyan","sessionId":"s1"}\n');
    expect(r.read("s1", f)).toBe("cyan");
  });

  it("keeps the color across scans with no new color lines", () => {
    const r = new SessionColorReader();
    const f = transcript(['{"type":"agent-color","agentColor":"pink","sessionId":"s1"}']);
    expect(r.read("s1", f)).toBe("pink");
    fs.appendFileSync(f, '{"type":"assistant","message":"..."}\n');
    expect(r.read("s1", f)).toBe("pink");
  });

  it("treats a non-palette value (default) as null", () => {
    const f = transcript(['{"type":"agent-color","agentColor":"default","sessionId":"s1"}']);
    expect(new SessionColorReader().read("s1", f)).toBeNull();
  });

  it("ignores an incomplete trailing line, then reads it once completed", () => {
    const r = new SessionColorReader();
    const f = transcript([]);
    fs.appendFileSync(f, '{"type":"agent-color","agentColor":"gre');
    expect(r.read("s1", f)).toBeNull();
    fs.appendFileSync(f, 'en","sessionId":"s1"}\n');
    expect(r.read("s1", f)).toBe("green");
  });

  it("survives a missing transcript", () => {
    expect(new SessionColorReader().read("s1", path.join(tmp(), "nope.jsonl"))).toBeNull();
  });
});

describe("resolveAccentColor", () => {
  it("prefers the explicit /color", () => {
    expect(resolveAccentColor("red", "some-repo")).toBe("red");
  });
  it("falls back to the repo auto color", () => {
    expect(resolveAccentColor(null, "some-repo")).toBe(autoColor("some-repo"));
  });
  it("returns null with nothing to go on", () => {
    expect(resolveAccentColor(null, null)).toBeNull();
  });
});
