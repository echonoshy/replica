// Run from the repository root with:
// pnpm --filter @wiki-memory/api exec tsx scripts/reclassify-facts.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.js";
import { zeroUsage } from "../src/db/interfaces.js";
import { SQLiteConnection } from "../src/db/sqlite-repo.js";
import { OpenAiGateway } from "../src/llm/openai-gateway.js";
import { SQLiteMemoryStateStore } from "../src/memory/memory-state.js";
import { isFact } from "../src/pipeline/analyzer.js";
import type { Claim, Fact } from "../src/pipeline/analyzer.js";
import { classifyFactsWithLlm } from "../src/pipeline/fact-classifier.js";
import { reconcile } from "../src/pipeline/wiki-compiler.js";
import { memoryControlsView } from "../src/routes/memory-controls.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const envPath = join(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const dataDir = process.env.DATA_DIR || join(repoRoot, "data");
const config = readConfig({ ...process.env, DATA_DIR: dataDir });
const gateway = new OpenAiGateway(config);
const connection = new SQLiteConnection(dataDir);
const memoryState = new SQLiteMemoryStateStore(connection.client);

const TARGET_SPACES = [
  { namespace: "personal", space_id: "chen_mo" },
  { namespace: "personal", space_id: "lin_xi" },
] as const;

type FactClaim = Extract<Claim, Fact>;

async function reclassifySpace(namespace: string, space_id: string) {
  const key = `${namespace}:${space_id}`;
  const row = connection.client
    .prepare("SELECT current_version FROM spaces WHERE namespace = ? AND space_id = ?")
    .get(namespace, space_id) as { current_version: number } | undefined;
  if (!row || !row.current_version) {
    console.log(`[skip] ${key}: no published snapshot`);
    return;
  }
  const version = row.current_version;
  const claimsPath = join(dataDir, "spaces", namespace, space_id, "snapshots", `v${version}`, "_claims.json");
  const claims = JSON.parse(readFileSync(claimsPath, "utf8")) as Claim[];
  const today = new Date().toISOString().slice(0, 10);

  const normalizedClaims = claims.map((claim) => {
    if (!isFact(claim) || !claim.expires_on) return claim;
    const { expires_on: _removed, ...rest } = claim;
    return rest;
  });
  const beforeView = memoryControlsView(memoryState, key, normalizedClaims);
  const aliases = memoryState.aliasLookupMap(key);
  const telemetry = memoryState.listTelemetry(key);
  const { current, originalByFact } = reconcile(normalizedClaims, today, { aliases, telemetry });

  const activeOriginals: FactClaim[] = [];
  const seen = new Set<Claim>();
  for (const active of current) {
    const original = originalByFact.get(active);
    if (!original || seen.has(original)) continue;
    seen.add(original);
    activeOriginals.push(original);
  }

  console.log(`\n=== Reclassifying ${key} (snapshot v${version}) ===`);
  console.log(`Active facts to classify: ${activeOriginals.length} (total claims: ${claims.length})`);
  console.log("Before stats:", beforeView.stats);

  const usage = zeroUsage();
  const classified = await classifyFactsWithLlm(gateway, activeOriginals, usage, {
    force: true,
    tier: "strong",
    batchSize: 35,
    throwOnError: true,
  });

  const replacements = new Map<Claim, FactClaim>();
  for (let i = 0; i < activeOriginals.length; i++) {
    replacements.set(activeOriginals[i], classified[i]);
  }
  const nextClaims = normalizedClaims.map((claim) => replacements.get(claim) ?? claim);

  const tmpPath = `${claimsPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(nextClaims, null, 2) + "\n", "utf8");
  renameSync(tmpPath, claimsPath);

  const afterView = memoryControlsView(memoryState, key, nextClaims);
  console.log("LLM usage:", usage);
  console.log("After stats:", afterView.stats);

  const pinnedFacts = afterView.facts.filter((f) => f.tier === "pinned_redline");
  console.log(`\nPinned Redlines (${pinnedFacts.length}):`);
  for (const f of pinnedFacts) {
    console.log(`  - [${f.scope}] ${f.subject} · ${f.predicate}: ${f.value}`);
  }

  const workingFacts = afterView.facts.filter((f) => f.tier === "working");
  console.log(`\nWorking facts (${workingFacts.length}):`);
  for (const f of workingFacts) {
    const exp = f.expires_on ? ` (expires_on: ${f.expires_on})` : "";
    console.log(`  - [${f.scope}] ${f.subject} · ${f.predicate}${exp}: ${f.value.slice(0, 80)}`);
  }

  const expiredByReclassify = classified.filter((f) => f.expires_on && f.expires_on < today);
  if (expiredByReclassify.length) {
    console.log(`\nFacts newly marked with past expires_on (< ${today}) (${expiredByReclassify.length}):`);
    for (const f of expiredByReclassify) {
      console.log(`  - [expires_on=${f.expires_on}] ${f.subject} · ${f.predicate}: ${f.value.slice(0, 80)}`);
    }
  }

  const hokkaido = nextClaims.filter((c) => isFact(c) && (`${c.subject} ${c.predicate} ${c.value}`).includes("北海道"));
  if (hokkaido.length) {
    console.log("\nHokkaido facts verification:");
    for (const f of hokkaido) {
      if (!isFact(f)) continue;
      console.log(`  - ${f.subject} · ${f.predicate} => tier=${f.tier}, scope=${f.scope}, expires_on=${f.expires_on ?? "none"}`);
    }
  }

  const dec7 = nextClaims.filter((c) => isFact(c) && (`${c.subject} ${c.predicate} ${c.value}`).includes("12 月 7 日") || isFact(c) && (`${c.subject} ${c.predicate} ${c.value}`).includes("12月7日"));
  if (dec7.length) {
    console.log("\nDec 7 facts verification:");
    for (const f of dec7) {
      if (!isFact(f)) continue;
      console.log(`  - ${f.subject} · ${f.predicate} => tier=${f.tier}, scope=${f.scope}, expires_on=${f.expires_on ?? "none"}`);
    }
  }
}

try {
  for (const { namespace, space_id } of TARGET_SPACES) {
    await reclassifySpace(namespace, space_id);
  }
} finally {
  connection.close();
}
