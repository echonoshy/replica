import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, FolderKanban, Plus, Sparkles, User, X } from "lucide-react";
import type { Space } from "@wiki-memory/shared";
import { api, spaceDisplayName, spaceKeyOf } from "../api";
import { getShowcaseMeta, getSpaceTestCases } from "../demoTestCases";
import { useApp } from "../context/AppContext";

export function SpaceSwitcherModal({ onClose }: { onClose: () => void }) {
  const { spaces, activeSpace, scenarios, selectSpace, refreshSpaceData } = useApp();
  const [creating, setCreating] = useState(false);
  const [spaceId, setSpaceId] = useState(() => `user_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`);
  const [purpose, setPurpose] = useState(
    "作为我的个人长期记忆空间，持续沉淀我的沟通风格、生活与工作偏好、重要日程、核心项目与人际关系，以及每一次习惯变更记录。",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const showcaseSpaces = spaces
    .filter((s) => {
      const meta = getShowcaseMeta(s);
      return meta && meta.badgeTone !== "blank";
    })
    .sort((a, b) => {
      const order = ["personal:chen_mo", "personal:lin_xi"];
      return order.indexOf(spaceKeyOf(a)) - order.indexOf(spaceKeyOf(b));
    });
  const otherSpaces = spaces.filter((s) => !showcaseSpaces.includes(s));

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.createSpace({
        namespace: "personal",
        space_id: spaceId.trim().toLowerCase(),
        purpose: purpose.trim(),
      });
      await refreshSpaceData(spaceKeyOf(created));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function renderRow(item: Space) {
    const isCurrent = activeSpace && spaceKeyOf(activeSpace) === spaceKeyOf(item);
    const meta = getShowcaseMeta(item);
    const testCaseCount = getSpaceTestCases(item, scenarios).length;
    const badgeClass = meta?.badgeTone === "deep"
      ? "bg-[#e8f8f1] text-[#0b7a55]"
      : meta?.badgeTone === "classic"
        ? "bg-[#f3f1ff] text-[#5344c7]"
        : meta?.badgeTone === "blank"
          ? "bg-[#eef4ff] text-[#245bdb]"
          : "";
    return (
      <button
        key={spaceKeyOf(item)}
        type="button"
        onClick={() => {
          selectSpace(spaceKeyOf(item));
          onClose();
        }}
        className={`flex w-full items-start gap-3 rounded-[10px] border p-3.5 text-left transition-all ${
          isCurrent
            ? "border-[#3370ff] bg-[#eef4ff]"
            : "border-[#eceef2] bg-white hover:border-[#cddfff] hover:bg-[#f8faff]"
        }`}
      >
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] ${
          item.namespace === "personal" ? "bg-[#eef4ff] text-[#3370ff]" : "bg-[#f0f2f5] text-[#646a73]"
        }`}>
          {item.namespace === "personal" ? <User size={15} /> : <FolderKanban size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[#1f2329]">{spaceDisplayName(item)}</span>
            {meta ? (
              <span className={`rounded-[7px] px-2 py-0.5 text-[10px] font-medium ${badgeClass}`}>
                {meta.badge}
              </span>
            ) : null}
            {testCaseCount > 0 ? (
              <span className="rounded-[7px] bg-[#f4f6fa] px-2 py-0.5 font-mono-num text-[10px] text-[#5c6370]">
                {testCaseCount} 个用例
              </span>
            ) : null}
            <span className="ml-auto font-mono-num text-[11px] text-[#8f959e]">
              {item.current_version ? `v${item.current_version}` : "空白"}
            </span>
            {isCurrent ? <Check size={15} className="text-[#3370ff]" /> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-[#646a73]">{item.purpose}</p>
        </div>
      </button>
    );
  }

  return (
    <dialog ref={dialog} aria-labelledby="space-dialog-title" onCancel={onClose}
      className="card-floating fixed inset-0 m-auto w-[calc(100%_-_32px)] max-w-[520px] overflow-hidden backdrop:bg-[#1f2329]/25"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div>
        <header className="flex items-center justify-between border-b border-[#f0f2f5] bg-[#fafbfc] px-5 py-4">
          <div>
            <h2 id="space-dialog-title" className="text-sm font-semibold text-[#1f2329]">
              {creating ? "新建个人记忆空间" : "空间管理"}
            </h2>
            <p className="text-xs text-[#8f959e]">
              {creating
                ? "创建一个独立的空白空间，从零开始体验对话与做梦整理"
                : "选择空间，查看其中的对话和记忆"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="关闭空间管理">
            <X size={18} />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {creating ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <label className="block text-xs font-medium text-[#5c6370]">
                空间标识（小写字母/数字/下划线）
                <input
                  value={spaceId}
                  onChange={(e) => setSpaceId(e.target.value)}
                  pattern="[a-z0-9][a-z0-9_\-]*"
                  required
                  className="mt-1.5 w-full rounded-[8px] border border-[#dee0e3] bg-[#fafbfc] px-3 py-2 font-mono-num text-sm focus:border-[#3370ff] focus:bg-white focus:outline-none"
                />
              </label>
              <label className="block text-xs font-medium text-[#5c6370]">
                记忆关注重点（Purpose）
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  rows={4}
                  required
                  className="mt-1.5 w-full rounded-[8px] border border-[#dee0e3] bg-[#fafbfc] px-3 py-2 text-sm focus:border-[#3370ff] focus:bg-white focus:outline-none"
                />
              </label>
              {error ? <p className="text-xs text-[#d83931]">{error}</p> : null}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCreating(false)} className="rounded-[7px] border border-[#e5e7eb] px-4 py-2 text-xs font-medium text-[#5c6370] hover:bg-[#f5f6f8]">
                  返回
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 rounded-[7px] bg-[#3370ff] px-4 py-2 text-xs font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
                >
                  <Sparkles size={13} /> {submitting ? "创建中…" : "创建并切换"}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {showcaseSpaces.length > 0 ? (
                <div>
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#3370ff]">预置测试场景空间</span>
                    <button
                      type="button"
                      onClick={() => setCreating(true)}
                      className="inline-flex items-center gap-1 rounded-[7px] bg-[#3370ff] px-3 py-1 text-xs font-medium text-white hover:bg-[#245bdb]"
                    >
                      <Plus size={12} /> 新建空间
                    </button>
                  </div>
                  <div className="space-y-2">{showcaseSpaces.map(renderRow)}</div>
                </div>
              ) : null}

              {otherSpaces.length > 0 ? (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#8f959e]">个人与自定义空间</span>
                    {showcaseSpaces.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="inline-flex items-center gap-1 rounded-[7px] bg-[#3370ff] px-3 py-1 text-xs font-medium text-white hover:bg-[#245bdb]"
                      >
                        <Plus size={12} /> 新建空间
                      </button>
                    ) : null}
                  </div>
                  <div className="space-y-2">{otherSpaces.map(renderRow)}</div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
