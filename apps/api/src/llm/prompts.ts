import { readFileSync } from "node:fs";

const names = ["analyzer", "organizer", "dreaming", "navigator", "synthesizer", "router", "compactor", "proactiveScout"] as const;
export type PromptName = (typeof names)[number];
export const prompts = Object.fromEntries(names.map((name) => [
  name, readFileSync(new URL(`../prompts/${name === "proactiveScout" ? "proactive-scout" : name}.md`, import.meta.url), "utf8").trim(),
])) as Record<PromptName, string>;
