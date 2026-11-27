import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { CreateIntentionInput } from "@wiki-memory/shared";

export type DemoIntentionSeed = Omit<CreateIntentionInput, "namespace" | "space_id">;

export const DEMO_PROACTIVE_INTENTIONS: Record<string, DemoIntentionSeed[]> = {
  "personal:chen_mo": [
    {
      kind: "event_based",
      priority: "high",
      source: "user",
      goal: "收到北极星 3.0 合规书面确认后，核对数据口径并提交灰度发布审批",
      subjects: ["北极星 3.0", "合规组", "灰度"],
      condition: {
        cue_text: "收到北极星 3.0 合规组对 10% 灰度范围的书面确认邮件或签字通知",
        match_event_types: ["email_received", "chat_turn", "app_signal", "custom"],
      },
      evidence_anchors: [
        "doc_6a62c5f1d3f0f19fede5906764511828#t8",
        "doc_344f5feb000c24ee1e8befd01b97b8cd#t11",
      ],
    },
    {
      kind: "risk_watch",
      priority: "redline",
      source: "user",
      goal: "守住每周三晚 19:30 与苏晴的固定羽毛球约定，临时加会先沟通改期",
      subjects: ["苏晴", "羽毛球", "周三晚"],
      condition: {
        cue_text: "周三晚上临时加会、复盘或工作饭局（17:30 后需接苏晴）",
        match_event_types: ["calendar_changed", "email_received", "chat_turn", "custom"],
      },
      evidence_anchors: [
        "doc_de5fc68feb692069cdac00267c63d2a6#t2",
      ],
    },
    {
      kind: "risk_watch",
      priority: "redline",
      source: "user",
      goal: "12 月 5 日上午陪父亲到同仁医院崇文门西区复查白内障，避免同期排会",
      subjects: ["陈默的父亲", "同仁医院", "白内障复查"],
      condition: {
        cue_text: "12 月 5 日上午新增会议或评审冲突（10:30–11:00 报到）",
        match_event_types: ["calendar_changed", "email_received", "chat_turn", "custom"],
        deadline: "2026-12-05T23:59:00+08:00",
      },
      evidence_anchors: [
        "doc_00cb5e3e4733ed9ddf37d8fc7209d46e#t2",
      ],
    },
  ],
  "personal:lin_xi": [
    {
      kind: "risk_watch",
      priority: "redline",
      source: "user",
      goal: "12 月 2 日至 5 日明远深圳出差期间，晚间谢绝所有客户视频与饭局",
      subjects: ["周明远", "品牌客户", "晚间会议"],
      condition: {
        cue_text: "12 月 2 日至 5 日晚上有品牌客户约看稿、线上会或饭局",
        match_event_types: ["email_received", "calendar_changed", "chat_turn", "custom"],
        deadline: "2026-12-05T23:59:00+08:00",
      },
      evidence_anchors: [
        "doc_dc609d20807b75d261e2a450b69401fd#t4",
      ],
    },
    {
      kind: "risk_watch",
      priority: "redline",
      source: "user",
      goal: "周二、周四客户会议最晚 16:00 收工，确保准时接乐乐放学",
      subjects: ["乐乐", "接园", "客户会议"],
      condition: {
        cue_text: "周二或周四下午客户会议超过 16:00 拖堂",
        match_event_types: ["calendar_changed", "chat_turn", "app_signal", "custom"],
      },
      evidence_anchors: [
        "doc_6292fdf898ae14e5e92638f53f88dff3#t2",
      ],
    },
    {
      kind: "event_based",
      priority: "redline",
      source: "user",
      goal: "幼儿园点心临时换牌子或口味时，立刻核对花生/坚果过敏原并通知换备用点心",
      subjects: ["乐乐", "花生", "坚果", "幼儿园点心"],
      condition: {
        cue_text: "幼儿园通知点心更换、含花生坚果或配料表不明",
        match_event_types: ["app_signal", "chat_turn", "email_received", "custom"],
      },
      evidence_anchors: [
        "doc_548296b11a0a8c367a5a8317408ff0c9#t5",
        "doc_47fa064495196e6020d73ac8bd96c4d4#t4",
      ],
    },
  ],
};

export function seedDemoIntentions(db: Database.Database, now = new Date().toISOString()) {
  const inserted: Record<string, number> = {};
  const hasSpace = db.prepare<[string], { id: string }>("SELECT id FROM spaces WHERE id = ?");
  const countIntentions = db.prepare<[string], number>("SELECT count(*) FROM proactive_intentions WHERE space_key = ?").pluck();
  const hasDoc = db.prepare<[string, string], { doc_id: string }>("SELECT doc_id FROM documents WHERE space_key = ? AND doc_id = ?");
  const insert = db.prepare(`INSERT INTO proactive_intentions (
    intention_id, space_key, kind, goal, condition_json, subjects_json,
    priority, status, evidence_anchors_json, source, snoozed_until, snapshot_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, NULL, NULL, ?, ?)`);

  db.transaction(() => {
    for (const [spaceKey, seeds] of Object.entries(DEMO_PROACTIVE_INTENTIONS)) {
      if (!hasSpace.get(spaceKey)) continue;
      if (Number(countIntentions.get(spaceKey)) > 0) {
        inserted[spaceKey] = 0;
        continue;
      }
      let count = 0;
      for (const seed of seeds) {
        const validAnchors = (seed.evidence_anchors ?? []).filter(anchor => {
          const docId = anchor.split("#")[0];
          return Boolean(docId && hasDoc.get(spaceKey, docId));
        });
        insert.run(
          "intention_" + randomUUID(),
          spaceKey,
          seed.kind,
          seed.goal,
          JSON.stringify(seed.condition ?? {}),
          JSON.stringify(seed.subjects ?? []),
          seed.priority ?? "normal",
          JSON.stringify(validAnchors),
          seed.source ?? "user",
          now,
          now,
        );
        count++;
      }
      inserted[spaceKey] = count;
    }
  }).immediate();

  return inserted;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dataDir = fileURLToPath(new URL("../../../../data/", import.meta.url));
  const db = new Database(join(dataDir, "wiki_memory.db"), { fileMustExist: true });
  try {
    const result = seedDemoIntentions(db);
    console.log("Demo proactive intentions seeded:", JSON.stringify(result));
  } finally {
    db.close();
  }
}
