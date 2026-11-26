export const locatorMarker = /^<!-- loc:([pst][1-9][0-9]*) -->\r?$/gm;
export const dateMarker = /^<!-- date:(\d{4}-\d{2}-\d{2}) -->\r?\n*/;

const citationTags = /(?<!\\)\[(?:src|chat):[^\]\r\n]*\]/g;
const isoDatePrefix = /^\d{4}-\d{2}-\d{2}/;

export function normalizeText(text: string) {
  return text.replace(/\r\n?/g, "\n").trim().replace(locatorMarker, "&lt;!-- loc:$1 --&gt;");
}

export function stripCitationTags(text: string) {
  return text
    .replace(citationTags, "")
    .replace(/[ \t]+([，。！？；：、,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function splitTurnBySpeaker(text: string): { userText: string; assistantText: string } {
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const blocks = text.split(/(?=^\*\*(?:User|Assistant|System|Developer|Tool)\*\*\n\n)/m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\*\*(User|Assistant|System|Developer|Tool)\*\*\n\n([\s\S]*)$/);
    if (!match) {
      userParts.push(trimmed);
      continue;
    }
    const role = match[1].toLowerCase();
    const body = match[2].trim();
    if (!body) continue;
    if (role === "user") userParts.push(body);
    else if (role === "assistant") assistantParts.push(body);
  }
  return { userText: userParts.join("\n\n"), assistantText: assistantParts.join("\n\n") };
}

export function groupMessagesIntoTurns(
  messages: ReadonlyArray<{ role: string; content: string; created_at?: string | null }>,
) {
  const turns: Array<{ parts: string[]; date?: string }> = [];
  for (const { role, content, created_at } of messages) {
    if (!content.trim()) continue;
    if (role === "user" || !turns.length) turns.push({ parts: [] });
    const current = turns.at(-1)!;
    const msgDate = created_at && isoDatePrefix.test(created_at) ? created_at.slice(0, 10) : undefined;
    if (msgDate && (!current.date || role === "user")) current.date = msgDate;
    const label = role[0].toUpperCase() + role.slice(1);
    current.parts.push(`**${label}**\n\n${normalizeText(content)}`);
  }
  return turns.map(({ parts, date }, index) => ({
    locator: `t${index + 1}`,
    text: parts.join("\n\n"),
    ...(date ? { date } : {}),
  }));
}
