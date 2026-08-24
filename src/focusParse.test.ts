import { describe, expect, it } from "vitest";
import { parseFocusOutput, rankCandidates } from "./focusParse";

describe("parseFocusOutput", () => {
  it("parses a single-match auto raise", () => {
    const r = parseFocusOutput(
      ["count=1", "hwnd=12345|title=ext.ts - proj - Visual Studio Code", "raised=12345", "foreground=True"].join("\n"),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].hwnd).toBe("12345");
    expect(r.raised).toBe(true);
    expect(r.foreground).toBe(true);
  });

  it("parses an ambiguous listing with no raise", () => {
    const r = parseFocusOutput(
      ["count=2", "hwnd=111|title=a.ts - proj - Visual Studio Code", "hwnd=222|title=b.ts - proj - Visual Studio Code"].join(
        "\r\n",
      ),
    );
    expect(r.raised).toBe(false);
    expect(r.candidates.map((c) => c.hwnd)).toEqual(["111", "222"]);
  });

  it("reports foreground=False as a failed raise", () => {
    const r = parseFocusOutput(["raised=9", "foreground=False"].join("\n"));
    expect(r.raised).toBe(true);
    expect(r.foreground).toBe(false);
  });

  it("survives empty or error output", () => {
    expect(parseFocusOutput("").candidates).toEqual([]);
    expect(parseFocusOutput("error=no-process").raised).toBe(false);
  });

  it("keeps titles containing an equals sign", () => {
    const r = parseFocusOutput("hwnd=5|title=a=b.ts - proj - Visual Studio Code");
    expect(r.candidates[0].title).toBe("a=b.ts - proj - Visual Studio Code");
  });
});

describe("rankCandidates", () => {
  const a = { hwnd: "1", title: "other.ts - proj - Visual Studio Code" };
  const b = { hwnd: "2", title: "focus.ts - proj - Visual Studio Code" };

  it("puts the window showing our active editor first", () => {
    expect(rankCandidates([a, b], "focus.ts").map((c) => c.hwnd)).toEqual(["2", "1"]);
  });

  it("preserves order when there is no hint", () => {
    expect(rankCandidates([a, b], undefined).map((c) => c.hwnd)).toEqual(["1", "2"]);
  });

  it("preserves order when the hint matches nothing", () => {
    expect(rankCandidates([a, b], "nope.ts").map((c) => c.hwnd)).toEqual(["1", "2"]);
  });

  it("does not mutate the input", () => {
    const input = [a, b];
    rankCandidates(input, "focus.ts");
    expect(input.map((c) => c.hwnd)).toEqual(["1", "2"]);
  });
});
