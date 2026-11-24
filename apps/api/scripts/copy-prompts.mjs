import { cp } from "node:fs/promises";

await cp(new URL("../src/prompts/", import.meta.url), new URL("../dist/prompts/", import.meta.url), { recursive: true });
