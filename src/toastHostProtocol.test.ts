import { describe, expect, it } from "vitest";
import { hideCommand, parseHostLine, showCommand } from "./toastHostProtocol";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("parseHostLine", () => {
  it("parses ready", () => {
    expect(parseHostLine("ready")).toEqual({ ev: "ready" });
  });

  it("parses the real activation captured in the spike", () => {
    const line = `activated|t1|${b64("action=reply")}|${b64("ok this is a reply\r")}`;
    expect(parseHostLine(line)).toEqual({
      ev: "activated",
      id: "t1",
      args: "action=reply",
      reply: "ok this is a reply", // trailing Enter stripped
    });
  });

  it("keeps interior newlines but strips only trailing ones", () => {
    const line = `activated|t2|${b64("action=reply")}|${b64("line1\nline2\r\n")}`;
    const ev = parseHostLine(line);
    expect(ev).toMatchObject({ reply: "line1\nline2" });
  });

  it("parses shown, dismissed, and err", () => {
    expect(parseHostLine("shown|t1")).toEqual({ ev: "shown", id: "t1" });
    expect(parseHostLine("dismissed|t1|TimedOut")).toEqual({ ev: "dismissed", id: "t1", reason: "TimedOut" });
    expect(parseHostLine(`err|${b64("boom")}`)).toEqual({ ev: "err", message: "boom" });
  });

  it("returns null for junk", () => {
    expect(parseHostLine("")).toBeNull();
    expect(parseHostLine("garbage")).toBeNull();
    expect(parseHostLine("shown|")).toBeNull();
    expect(parseHostLine(`activated|`)).toBeNull();
  });

  it("survives invalid base64 fields", () => {
    const ev = parseHostLine("activated|t1|!!!|???");
    expect(ev).toMatchObject({ ev: "activated", id: "t1" });
  });
});

describe("commands", () => {
  it("round-trips the xml through show", () => {
    const cmd = showCommand("r1", "abc123", "claude-toasts", "<toast/>");
    expect(cmd).toBe(`show|r1|abc123|claude-toasts|${b64("<toast/>")}\n`);
  });
  it("encodes hide", () => {
    expect(hideCommand("abc", "grp")).toBe("hide|abc|grp\n");
  });
});
