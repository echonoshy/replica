import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RetrieveResult, Space, SpaceRef } from "@replica/shared";
import { api, spaceKeyOf } from "../api";
import type { ChatMessage, ChatSession, ConversationSearchHit, ModelInfo, ScenariosResponse, SpaceOverviewResponse } from "../api";

export type CenterViewMode = "chat" | "memory";
export type RightPanelTab = "details" | "source" | "dream";

type DocInspectTarget = { kind?: "doc"; space: SpaceRef; anchor: string; version?: number };
export type SourceInspectTarget = DocInspectTarget | { kind: "chat"; sessionId: string; locator: string };

interface AppContextValue {
  spaces: Space[];
  activeSpace: Space | null;
  scenarios: ScenariosResponse | null;
  model: ModelInfo | undefined;
  overview: SpaceOverviewResponse | null;
  selectSpace: (key: string) => void;
  refreshSpaceData: (forceKey?: string) => Promise<void>;

  sessions: ChatSession[];
  pendingCount: number;
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  sendingMessage: boolean;
  compareBaseline: boolean;
  setCompareBaseline: (v: boolean) => void;
  startNewChat: () => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  sendChatMessage: (content: string) => Promise<void>;

  centerMode: CenterViewMode;
  setCenterMode: (mode: CenterViewMode) => void;
  memoryTarget: { path: string; request: number };
  openMemory: (path?: string) => void;
  rightOpen: boolean;
  setRightOpen: (open: boolean) => void;
  rightTab: RightPanelTab;
  setRightTab: (tab: RightPanelTab) => void;
  focusedRetrieval: RetrieveResult | null;
  focusedConversationHits: ConversationSearchHit[];
  focusRecall: (message: ChatMessage) => void;
  inspectedSource: SourceInspectTarget | null;
  inspectSource: (target: DocInspectTarget) => void;
  inspectChatTurn: (sessionId: string, locator: string) => void;

  dreamJobId: string | null;
  triggeringDream: boolean;
  dreamRunning: boolean;
  triggerDream: (forceConsolidate?: boolean) => Promise<void>;
  onDreamSettled: () => Promise<void>;

  error: string | null;
  clearError: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const SPACE_STORAGE_KEY = "zhiwei:active-space";
const DEFAULT_MEMORY_TARGET = { path: "_index.md", request: 0 };
const NO_CONVERSATION_HITS: ConversationSearchHit[] = [];

export function AppProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSpaceKey, setSelectedSpaceKey] = useState<string>(
    () => localStorage.getItem(SPACE_STORAGE_KEY) ?? "",
  );
  const [scenarios, setScenarios] = useState<ScenariosResponse | null>(null);
  const [sessionModel, setSessionModel] = useState<ModelInfo>();
  const [overview, setOverview] = useState<SpaceOverviewResponse | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [compareBaseline, setCompareBaseline] = useState(false);

  const [centerMode, setCenterMode] = useState<CenterViewMode>("chat");
  const [memoryTarget, setMemoryTarget] = useState(DEFAULT_MEMORY_TARGET);
  const [rightOpen, setRightOpen] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [rightTab, setRightTab] = useState<RightPanelTab>("details");
  const [focusedReply, setFocusedReply] = useState<ChatMessage | null>(null);
  const [inspectedSource, setInspectedSource] = useState<SourceInspectTarget | null>(null);

  const [dreamJobId, setDreamJobId] = useState<string | null>(null);
  const [forgetJobIds, setForgetJobIds] = useState<string[]>([]);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [triggeringDream, setTriggeringDream] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipNextSessionFetchRef = useRef<string | null>(null);
  const currentSpaceKey = useRef("");
  const navigationRevision = useRef(0);

  const pickBestSpace = useCallback((list: Space[], preferred?: string) => {
    if (!list.length) return "";
    if (preferred && list.some((s) => spaceKeyOf(s) === preferred)) return preferred;
    const lin = list.find((s) => s.namespace === "personal" && s.space_id === "lin_yuan");
    if (lin) return spaceKeyOf(lin);
    const anyPersonal = list.find((s) => s.namespace === "personal");
    if (anyPersonal) return spaceKeyOf(anyPersonal);
    return spaceKeyOf(list[0]);
  }, []);

  const refreshSpacesList = useCallback(async (forceKey?: string) => {
    const [spacesRes, scenariosRes] = await Promise.all([
      api.listSpaces(),
      api.getScenarios().catch(() => null),
    ]);
    setSpaces(spacesRes.spaces);
    if (scenariosRes) setScenarios(scenariosRes);
    setSelectedSpaceKey((prev) => {
      const next = pickBestSpace(spacesRes.spaces, forceKey || prev);
      if (next) localStorage.setItem(SPACE_STORAGE_KEY, next);
      return next;
    });
  }, [pickBestSpace]);

  useEffect(() => {
    void refreshSpacesList().catch((err: Error) => setError(err.message));
  }, [refreshSpacesList]);

  const activeSpace = useMemo(
    () => spaces.find((s) => spaceKeyOf(s) === selectedSpaceKey) ?? spaces[0] ?? null,
    [spaces, selectedSpaceKey],
  );

  const loadForActiveSpace = useCallback(async (space: Space) => {
    const [ov, sessRes] = await Promise.all([
      api.getOverview(space),
      api.listSessions(space),
    ]);
    if (currentSpaceKey.current !== spaceKeyOf(space)) return null;
    setOverview(ov);
    setSessions(sessRes.sessions);
    setPendingCount(sessRes.pending_count);
    setSessionModel(sessRes.model);
    if (sessRes.active_dream_job_id) {
      setDreamJobId(sessRes.active_dream_job_id);
      setDreamRunning(true);
    }
    return sessRes.pending_count;
  }, []);

  const refreshAfterRetraction = useEffectEvent(async () => {
    await Promise.all([refreshSpacesList(), activeSpace ? loadForActiveSpace(activeSpace) : null]);
  });

  useEffect(() => {
    if (!forgetJobIds.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 350;

    async function poll() {
      const jobs = await Promise.all(forgetJobIds.map((id) => api.getJob(id).catch(() => null)));
      if (cancelled) return;
      const settled = jobs.flatMap((job) => job?.status === "published" || job?.status === "failed" ? [job] : []);
      if (!settled.length) {
        timer = setTimeout(poll, delay);
        delay = Math.min(delay * 2, 3500);
        return;
      }
      const completedIds = new Set(settled.map((job) => job.job_id));
      setForgetJobIds((ids) => ids.filter((id) => !completedIds.has(id)));
      void refreshAfterRetraction().then(() => {
        const failure = settled.find((job) => job.status === "failed");
        if (failure) setError(failure.error_message ?? "记忆撤回失败");
      }).catch((err: Error) => setError(err.message));
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [forgetJobIds]);

  useEffect(() => {
    if (!activeSpace) return;
    currentSpaceKey.current = spaceKeyOf(activeSpace);
    const navigation = ++navigationRevision.current;
    setOverview(null);
    setSessions([]);
    setPendingCount(0);
    setSessionModel(undefined);
    setActiveSessionId(null);
    setMessages([]);
    setFocusedReply(null);
    setInspectedSource(null);
    setDreamJobId(null);
    setDreamRunning(false);
    setMemoryTarget(DEFAULT_MEMORY_TARGET);
    setCenterMode("chat");
    void loadForActiveSpace(activeSpace)
      .then((pending) => {
        if (pending !== null && navigationRevision.current === navigation) setRightTab(pending > 0 ? "dream" : "details");
      })
      .catch((err: Error) => setError(err.message));
  }, [activeSpace?.namespace, activeSpace?.space_id, loadForActiveSpace]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setFocusedReply(null);
      setLoadingMessages(false);
      return;
    }
    if (skipNextSessionFetchRef.current === activeSessionId) {
      skipNextSessionFetchRef.current = null;
      return;
    }
    let alive = true;
    setLoadingMessages(true);
    void api.getSession(activeSessionId)
      .then((res) => {
        if (!alive) return;
        setMessages(res.messages);
        setFocusedReply(res.messages.findLast((m) => m.role === "assistant") ?? null);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoadingMessages(false);
      });
    return () => { alive = false; };
  }, [activeSessionId]);

  const refreshSpaceData = useCallback(async (forceKey?: string) => {
    setError(null);
    try {
      await refreshSpacesList(forceKey);
      if (activeSpace && !forceKey) {
        await loadForActiveSpace(activeSpace);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refreshSpacesList, activeSpace, loadForActiveSpace]);

  const selectSpace = useCallback((key: string) => {
    setSelectedSpaceKey(key);
    localStorage.setItem(SPACE_STORAGE_KEY, key);
  }, []);

  const startNewChat = useCallback(() => {
    navigationRevision.current++;
    setActiveSessionId(null);
    setMessages([]);
    setFocusedReply(null);
    setCenterMode("chat");
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    if (activeSessionId !== sessionId) {
      navigationRevision.current++;
      setMessages([]);
      setFocusedReply(null);
      setLoadingMessages(true);
    }
    setActiveSessionId(sessionId);
    setCenterMode("chat");
    setRightTab("details");
  }, [activeSessionId]);

  const openMemory = useCallback((path = "_index.md") => {
    setMemoryTarget((target) => ({ path, request: target.request + 1 }));
    setCenterMode("memory");
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    const navigation = navigationRevision.current;
    let forgetJobId: string | null | undefined;
    try {
      ({ forget_job_id: forgetJobId } = await api.deleteSession(sessionId));
      if (activeSessionId === sessionId && navigation === navigationRevision.current) {
        setActiveSessionId(null);
        setMessages([]);
        setFocusedReply(null);
        setInspectedSource(null);
        setRightTab("details");
      }
      if (activeSpace) await loadForActiveSpace(activeSpace);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (forgetJobId) {
        const id = forgetJobId;
        setForgetJobIds((ids) => [...ids, id]);
      }
    }
  }, [activeSessionId, activeSpace, loadForActiveSpace]);

  const sendChatMessage = useCallback(async (rawContent: string) => {
    const content = rawContent.trim();
    if (!activeSpace || !content || sendingMessage) return;
    setSendingMessage(true);
    setError(null);

    let sid = activeSessionId;
    const navigation = navigationRevision.current;
    const activeChat = () => navigationRevision.current === navigation;
    const tempUserId = -Date.now();
    try {
      if (!sid) {
        const created = await api.createSession(activeSpace);
        sid = created.session.session_id;
        if (activeChat()) {
          skipNextSessionFetchRef.current = sid;
          setActiveSessionId(sid);
          setSessions((prev) => [created.session, ...prev]);
        }
      }

      const optimisticUser: ChatMessage = {
        id: tempUserId,
        session_id: sid,
        role: "user",
        content,
        baseline_reply: null,
        retrieval: null,
        citations: [],
        tokens: null,
        latency_ms: null,
        created_at: new Date().toISOString(),
      };
      if (activeChat()) setMessages((prev) => [...prev, optimisticUser]);

      const result = await api.sendMessage(sid, {
        content,
        compare_baseline: compareBaseline,
        verify_raw_sources: true,
      });

      if (activeChat()) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== tempUserId && m.id !== result.user_message.id && m.id !== result.assistant_message.id),
          result.user_message,
          result.assistant_message,
        ]);
        setFocusedReply(result.assistant_message);
      }

      const sessRes = await api.listSessions(activeSpace);
      if (currentSpaceKey.current === spaceKeyOf(activeSpace)) {
        setSessions(sessRes.sessions);
        setPendingCount(sessRes.pending_count);
        setSessionModel(sessRes.model);
      }
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempUserId));
      setError((err as Error).message);
    } finally {
      setSendingMessage(false);
    }
  }, [activeSpace, activeSessionId, compareBaseline, sendingMessage]);

  const focusRecall = useCallback((message: ChatMessage) => {
    setFocusedReply(message);
    setRightTab("details");
    setRightOpen(true);
  }, []);

  const inspectSource = useCallback((target: SourceInspectTarget) => {
    setInspectedSource(target);
    setRightTab("source");
    setRightOpen(true);
  }, []);

  const inspectChatTurn = useCallback((sessionId: string, locator: string) => {
    inspectSource({ kind: "chat", sessionId, locator });
  }, [inspectSource]);

  const triggerDream = useCallback(async (forceConsolidate = false) => {
    if (!activeSpace || triggeringDream || dreamRunning) return;
    setTriggeringDream(true);
    setError(null);
    setRightTab("dream");
    setRightOpen(true);
    try {
      const res = await api.triggerDream(activeSpace, forceConsolidate);
      if (currentSpaceKey.current !== spaceKeyOf(activeSpace)) return;
      setDreamJobId(res.job.job_id);
      setDreamRunning(true);
      await loadForActiveSpace(activeSpace);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTriggeringDream(false);
    }
  }, [activeSpace, triggeringDream, dreamRunning, loadForActiveSpace]);

  const onDreamSettled = useCallback(async () => {
    if (!activeSpace) return;
    try {
      await Promise.all([refreshSpacesList(), loadForActiveSpace(activeSpace)]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (currentSpaceKey.current === spaceKeyOf(activeSpace)) setDreamRunning(false);
    }
  }, [activeSpace, refreshSpacesList, loadForActiveSpace]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.session_id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  return (
    <AppContext.Provider
      value={{
        spaces,
        activeSpace,
        scenarios,
        model: sessionModel ?? scenarios?.model,
        overview,
        selectSpace,
        refreshSpaceData,
        sessions,
        pendingCount,
        activeSessionId,
        activeSession,
        messages,
        loadingMessages,
        sendingMessage,
        compareBaseline,
        setCompareBaseline,
        startNewChat,
        selectSession,
        deleteSession,
        sendChatMessage,
        centerMode,
        setCenterMode,
        memoryTarget,
        openMemory,
        rightOpen,
        setRightOpen,
        rightTab,
        setRightTab,
        focusedRetrieval: focusedReply?.retrieval ?? null,
        focusedConversationHits: focusedReply?.conversation_hits ?? NO_CONVERSATION_HITS,
        focusRecall,
        inspectedSource,
        inspectSource,
        inspectChatTurn,
        dreamJobId,
        triggeringDream,
        dreamRunning,
        triggerDream,
        onDreamSettled,
        error,
        clearError: () => setError(null),
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
