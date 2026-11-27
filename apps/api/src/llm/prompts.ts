import { readFileSync } from "node:fs";

const names = ["analyzer", "organizer", "dreaming", "navigator", "synthesizer", "router", "compactor", "proactiveScout", "factClassifier"] as const;
export type PromptName = (typeof names)[number];
const fileNames: Partial<Record<PromptName, string>> = {
  proactiveScout: "proactive-scout",
  factClassifier: "fact-classifier",
};
export const prompts = Object.fromEntries(names.map((name) => [
  name, readFileSync(new URL(`../prompts/${fileNames[name] ?? name}.md`, import.meta.url), "utf8").trim(),
])) as Record<PromptName, string>;
