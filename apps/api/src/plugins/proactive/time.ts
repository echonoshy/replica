import type { ProactivePolicy } from "@wiki-memory/shared";

export const DAY = 86_400_000;
export const iso = (millis: number) => new Date(millis).toISOString();
export const shiftDay = (day: string, count: number) => iso(Date.parse(day) + count * DAY).slice(0, 10);
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localTime(ms: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(zone, formatter);
  }
  const [date, time] = formatter.format(ms).split(" ");
  return { date, time };
}

// Try the offsets on either side of a transition. Choose the earlier occurrence
// in a fold, or advance by the missing interval in a spring-forward gap.
export function wallTime(day: string, time: string, zone: string, earliest = -Infinity) {
  const target = Date.parse(day + "T" + time + ":00Z");
  const wall = (ms: number) => {
    const local = localTime(ms, zone);
    return Date.parse(local.date + "T" + local.time + ":00Z");
  };
  const candidates = [-2, 0, 2].map((delta) => {
    const probe = target + delta * DAY;
    const utc = target - (wall(probe) - probe);
    return { utc, late: wall(utc) - target };
  }).filter(({ late, utc }) => late >= 0 && utc >= earliest).sort((a, b) => a.late - b.late || a.utc - b.utc);
  return candidates[0].utc;
}

export function quietUntil(ms: number, policy: ProactivePolicy) {
  const { date, time } = localTime(ms, policy.timezone);
  const { quiet_start: start, quiet_end: end } = policy;
  if (start === end) return ms;
  const overnight = start > end;
  const quiet = overnight ? time >= start || time < end : time >= start && time < end;
  return quiet ? wallTime(shiftDay(date, Number(overnight && time >= start)), end, policy.timezone, ms) : ms;
}
