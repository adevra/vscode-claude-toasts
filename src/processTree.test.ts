import { describe, expect, it } from "vitest";
import { decideBinding, parseAncestry } from "./processTree";

const REAL_OUTPUT = [
  "anc=56032|node.exe|0",
  "anc=64312|bash.exe|0",
  "anc=63900|claude.exe|0",
  "anc=31996|WmiPrvSE.exe|0",
].join("\r\n");

const WT_OUTPUT = [
  "anc=1000|claude.exe|0",
  "anc=2000|pwsh.exe|0",
  "anc=3000|WindowsTerminal.exe|328466",
  "anc=4000|explorer.exe|65552",
].join("\n");

describe("parseAncestry", () => {
  it("parses real output child-first", () => {
    const chain = parseAncestry(REAL_OUTPUT);
    expect(chain).toHaveLength(4);
    expect(chain[0]).toEqual({ pid: 56032, name: "node.exe", hwnd: "0" });
    expect(chain[2].name).toBe("claude.exe");
  });

  it("keeps window handles", () => {
    const chain = parseAncestry(WT_OUTPUT);
    expect(chain[2]).toEqual({ pid: 3000, name: "WindowsTerminal.exe", hwnd: "328466" });
  });

  it("ignores junk lines and empty input", () => {
    expect(parseAncestry("")).toEqual([]);
    expect(parseAncestry("error=no-process\nnonsense")).toEqual([]);
    expect(parseAncestry("anc=abc|bad|0")).toEqual([]);
  });
});

describe("decideBinding", () => {
  it("binds to the exact VS Code terminal when an ancestor is its shell", () => {
    const chain = parseAncestry(WT_OUTPUT);
    const b = decideBinding(chain, new Set([2000]));
    expect(b).toEqual({ kind: "terminal", shellPid: 2000 });
  });

  it("prefers a terminal match over a window ancestor", () => {
    const chain = parseAncestry(WT_OUTPUT);
    // Even though WindowsTerminal has a window, pid 2000 is a VS Code terminal shell.
    expect(decideBinding(chain, new Set([2000, 9999])).kind).toBe("terminal");
  });

  it("falls back to the nearest windowed ancestor for external sessions", () => {
    const chain = parseAncestry(WT_OUTPUT);
    const b = decideBinding(chain, new Set([12345]));
    expect(b).toEqual({ kind: "external", hwnd: "328466" });
  });

  it("returns unknown when nothing matches and nothing has a window", () => {
    const chain = parseAncestry(REAL_OUTPUT);
    expect(decideBinding(chain, new Set())).toEqual({ kind: "unknown" });
  });
});
