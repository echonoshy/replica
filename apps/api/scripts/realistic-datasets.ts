import { atlasDataset } from "./datasets/atlas-platform.js";
import { salesDataset } from "./datasets/enterprise-q4.js";
import { zhouRanDataset } from "./datasets/zhou-ran.js";

export interface Chat {
  date: string;
  title: string;
  messages: { role: "user" | "assistant"; content: string }[];
  noiseMessages: number[]; // zero-based
}

export interface Dataset {
  namespace: string;
  space_id: string;
  purpose: string;
  batches: Chat[][];
  pending: Chat[];
  followUp?: { title: string; date: string; messages: Chat["messages"]; noiseMessages: number[] };
}

export const datasets: Dataset[] = [atlasDataset, salesDataset, zhouRanDataset];
