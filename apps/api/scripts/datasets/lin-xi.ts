import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dataset } from "../realistic-datasets.js";

const dataPath = resolve(dirname(fileURLToPath(import.meta.url)), "data/lin-xi.json");
export const linXiDataset = JSON.parse(readFileSync(dataPath, "utf8")) as Dataset;
