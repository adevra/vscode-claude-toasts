/** Pure line protocol for the toast host (media/ToastHost.cs). Testable, no I/O. */

export type HostEvent =
  | { ev: "ready" }
  | { ev: "shown"; id: string }
  | { ev: "activated"; id: string; args: string; reply: string }
  | { ev: "dismissed"; id: string; reason: string }
  | { ev: "err"; message: string };

function unB64(s: string): string {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Parse one stdout line from the host; null for unrecognized lines. */
export function parseHostLine(line: string): HostEvent | null {
  const t = line.trim();
  if (!t) return null;
  if (t === "ready") return { ev: "ready" };
  const parts = t.split("|");
  switch (parts[0]) {
    case "shown":
      return parts[1] ? { ev: "shown", id: parts[1] } : null;
    case "activated":
      if (!parts[1]) return null;
      return {
        ev: "activated",
        id: parts[1],
        args: unB64(parts[2] ?? ""),
        // Enter in the toast's input box submits with a trailing \r.
        reply: unB64(parts[3] ?? "").replace(/[\r\n]+$/, ""),
      };
    case "dismissed":
      return parts[1] ? { ev: "dismissed", id: parts[1], reason: parts[2] ?? "" } : null;
    case "err":
      return { ev: "err", message: unB64(parts[1] ?? "") };
    default:
      return null;
  }
}

/** Encode a show command line. */
export function showCommand(id: string, tag: string, group: string, xml: string): string {
  return `show|${id}|${tag}|${group}|${Buffer.from(xml, "utf8").toString("base64")}\n`;
}

export function hideCommand(tag: string, group: string): string {
  return `hide|${tag}|${group}\n`;
}
