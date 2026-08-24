import { describe, expect, it } from "vitest";
import { buildToastXml } from "./windows";
import { ToastRequest } from "./index";

function req(over: Partial<ToastRequest> = {}): ToastRequest {
  return {
    kind: "complete",
    title: "Claude finished · proj",
    body: "All done.",
    urgency: "normal",
    sticky: false,
    sound: true,
    tag: "s1:complete",
    ...over,
  };
}

describe("buildToastXml", () => {
  it("embeds the logo as an appLogoOverride file URI", () => {
    const xml = buildToastXml(req(), "C:\\Users\\me\\claude-logo.png");
    expect(xml).toContain('placement="appLogoOverride"');
    expect(xml).toContain("file:///C:/Users/me/claude-logo.png");
  });

  it("omits the logo when no icon path is given", () => {
    expect(buildToastXml(req())).not.toContain("appLogoOverride");
  });

  it("marks sticky toasts as urgent and normal ones not", () => {
    expect(buildToastXml(req({ sticky: true }))).toContain('scenario="urgent"');
    expect(buildToastXml(req({ sticky: false }))).not.toContain("scenario=");
  });

  it("silences audio only when sound is off", () => {
    expect(buildToastXml(req({ sound: false }))).toContain('<audio silent="true"/>');
    expect(buildToastXml(req({ sound: true }))).not.toContain("<audio");
  });

  it("renders the attribution line when given", () => {
    const xml = buildToastXml(req({ attribution: "vscode-claude-toasts · main" }));
    expect(xml).toContain('<text placement="attribution">vscode-claude-toasts · main</text>');
  });

  it("omits the attribution line when absent", () => {
    expect(buildToastXml(req())).not.toContain("attribution");
  });

  it("renders the color strip as an inline image", () => {
    const xml = buildToastXml(req({ stripPath: "C:\\store\\strips\\strip-red.png" }));
    expect(xml).toContain('<image src="file:///C:/store/strips/strip-red.png"/>');
  });

  it("xml-escapes the launch uri and text", () => {
    const xml = buildToastXml(req({ title: "a & b <c>", launchUri: "vscode://x/focus?session=a&b" }));
    expect(xml).toContain("a &amp; b &lt;c&gt;");
    expect(xml).toContain("session=a&amp;b");
    expect(xml).not.toContain("session=a&b<");
  });
});
