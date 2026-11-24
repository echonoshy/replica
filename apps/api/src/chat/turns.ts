export const locatorMarker = /^<!-- loc:([pst][1-9][0-9]*) -->\r?$/gm;

export function normalizeText(text: string) {
  return text.replace(/\r\n?/g, "\n").trim().replace(locatorMarker, "&lt;!-- loc:$1 --&gt;");
}

export function groupMessagesIntoTurns(messages: ReadonlyArray<{ role: string; content: string }>) {
  const turns: string[][] = [];
  for (const { role, content } of messages) {
    if (!content.trim()) continue;
    if (role === "user" || !turns.length) turns.push([]);
    const label = role[0].toUpperCase() + role.slice(1);
    turns.at(-1)!.push(`**${label}**\n\n${normalizeText(content)}`);
  }
  return turns.map((parts, index) => ({ locator: `t${index + 1}`, text: parts.join("\n\n") }));
}
