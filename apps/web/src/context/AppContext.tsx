import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RetrieveResult, Space, SpaceRef } from "@wiki-memory/shared";
import { api, ApiError, spaceKeyOf } from "../api";
import type {
  ChatAttachmentResponse, ChatDreamMode, ChatMessage, ChatSession, ConversationSearchHit, MemoryControlsResponse,
  AckReason, CreateIntentionInput, ProactiveEventInput, ProactiveEventResult, ProactiveProfile, ProspectiveIntention,
  ModelInfo, Nudge, NudgeAck, NudgesResult, ProactivePolicy, ScenariosResponse, SpaceOverviewResponse,
} from "../api";

type AckExtra = { reason?: AckReason; keep_reminding?: boolean };
type NewIntention = Omit<CreateIntentionInput, keyof SpaceRef>;
type EventDetails = Omit<ProactiveEventInput, keyof SpaceRef>;

export type CenterViewMode = "chat" | "memory" | "inbox";
export type RightPanelTab = "details" | "source" | "dream" | "controls";

type DocInspectTarget = { kind?: "doc"; space: SpaceRef; anchor: string; version?: number };
export type SourceInspectTarget = DocInspectTarget | { kind: "chat"; sessionId: string; locator: string };
type RestoredDraft = { sessionId: string; text: string };

type Toast = { id: number; message: string; undoLabel?: string; onUndo?: () => void | Promise<void> };
type ToastOptions = Pick<Toast, "undoLabel" | "onUndo"> & { durationMs?: number };

interface AppContextValue extends Pick<typeof api,
  "patchFactControl" | "addEntityAlias" | "deleteEntityAlias" | "addHotMemory" | "dismissHotMemory"> {
  spaces: Space[];
  activeSpace: Space | null;
  scenarios: ScenariosResponse | null;
  model: ModelInfo | undefined;
  overview: SpaceOverviewResponse | null;
  selectSpace: (key: string) => void;
  refreshSpaceData: (forceKey?: string) => Promise<void>;

  memoryControls: MemoryControlsResponse | null;
  memoryControlsError: string | null;
  refreshMemoryControls: () => Promise<MemoryControlsResponse | null>;
  uploadingAttachment: boolean;
  attachments: Record<number, ChatAttachmentResponse["attachment"]>;
  uploadChatAttachment: (sessionId: string | null, file: File, note?: string) => Promise<boolean>;

  sessions: ChatSession[];
  pendingCount: number;
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  messages: ChatMessage[];
  hotMemoryActions: Record<number, "remember" | "forget">;
  loadingMessages: boolean;
  sendingMessage: boolean;
  streamingStatus: string | null;
  splitCompareLocked: boolean;
  setSplitCompareLocked: (v: boolean) => void;
  dreamModalOpen: boolean;
  setDreamModalOpen: (v: boolean) => void;
  timeTravelOpen: boolean;
  setTimeTravelOpen: (v: boolean) => void;
  cmdkOpen: boolean;
  setCmdkOpen: (v: boolean) => void;
  toast: Toast | null;
  showToast: (message: string, opts?: ToastOptions) => void;
  dismissToast: () => void;
  compareBaseline: boolean;
  setCompareBaseline: (v: boolean) => void;
  startNewChat: () => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  sendChatMessage: (content: string, overrideSessionId?: string) => Promise<boolean>;
  restoredDraft: RestoredDraft | null;
  clearRestoredDraft: (draft: RestoredDraft) => void;

  proactiveAvailable: boolean;
  activeView: "chat" | "library" | "proactive";
  activeWhisper: Nudge | null;
  proactiveInbox: { pending: Nudge[]; history: Nudge[] };
  pendingNudges: Nudge[];
  historyNudges: Nudge[];
  proactivePolicy: ProactivePolicy | null;
  tuckedNudgeIds: string[];
  evaluatingProactive: boolean;
  proactiveNotice: string | null;
  loadingProactiveInbox: boolean;
  openingNudgeSession: boolean;
  openInbox: () => void;
  tuckWhisper: (nudgeId: string) => void;
  ackNudge: (nudgeId: string, action: NudgeAck["action"], snoozeUntil?: string, extra?: AckExtra) => Promise<void>;
  intentions: ProspectiveIntention[];
  intentionsTotal: number | null;
  intentionsLoadFailed: boolean;
  proactiveProfile: ProactiveProfile | null;
  refreshProactiveExtras: () => Promise<void>;
  executeNudgeAction: (id: string, actionId: string, note?: string) => Promise<void>;
  createIntention: (input: NewIntention) => Promise<void>;
  updateIntentionStatus: (id: string, status: ProspectiveIntention["status"]) => Promise<void>;
  deleteIntention: (id: string) => Promise<void>;
  simulateEvent: (input: EventDetails) => Promise<ProactiveEventResult | null>;
  runProactiveScout: () => Promise<void>;
  openNudgeSession: (nudgeId: string, initialReply?: string) => Promise<void>;
  updateProactivePolicy: (patch: Partial<ProactivePolicy>) => Promise<void>;
  evaluateProactive: (silent?: boolean) => Promise<void>;
  simulatedNudgeCount: number;
  simulateProactive: (nowIso: string, label?: string) => Promise<void>;
  clearSimulatedNudges: () => void;

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
  triggerDream: (modeOrForce?: boolean | ChatDreamMode) => Promise<void>;
  onDreamSettled: () => Promise<void>;

  error: string | null;
  clearError: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const SPACE_STORAGE_KEY = "zhiwei:active-space";
const DEFAULT_MEMORY_TARGET = { path: "_index.md", request: 0 };
const NO_CONVERSATION_HITS: ConversationSearchHit[] = [];
const NUDGE_KIND_ORDER = { conflict_check: 0, reminder: 1, follow_up: 2, digest: 3, risk_alert: 0, event_trigger: 1, open_loop: 2 } satisfies Record<Nudge["kind"], number>;
const newestNudgeFirst = (a: Nudge, b: Nudge) => Date.parse(b.deliver_after) - Date.parse(a.deliver_after);
const prioritizeNudges = (nudges: Nudge[]) => nudges.toSorted((a, b) =>
  Number(b.urgency === "urgent") - Number(a.urgency === "urgent") ||
  NUDGE_KIND_ORDER[a.kind] - NUDGE_KIND_ORDER[b.kind] || newestNudgeFirst(a, b),
);

function upsertNudge(nudges: Nudge[], nudge: Nudge) {
  return [nudge, ...nudges.filter((item) => item.nudge_id !== nudge.nudge_id)];
}

type ProactiveScope = {
  space: SpaceRef;
  seen: Set<string>;
  history: Map<string, Nudge>;
  extrasRequest: number;
  inboxRequest: number;
  policyRevision: number;
  evaluating: boolean;
  ready: boolean;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSpaceKey, setSelectedSpaceKey] = useState<string>(
    () => localStorage.getItem(SPACE_STORAGE_KEY) ?? "",
  );
  const [scenarios, setScenarios] = useState<ScenariosResponse | null>(null);
  const [sessionModel, setSessionModel] = useState<ModelInfo>();
  const [overview, setOverview] = useState<SpaceOverviewResponse | null>(null);

  const [memoryControls, setMemoryControls] = useState<MemoryControlsResponse | null>(null);
  const [memoryControlsError, setMemoryControlsError] = useState<string | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachments, setAttachments] = useState<AppContextValue["attachments"]>({});
  const chatBusy = useRef(false);
  const controlsRequest = useRef(0);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [activeSessionId, commitActiveSessionId] = useState<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hotMemoryActions, setHotMemoryActions] = useState<AppContextValue["hotMemoryActions"]>({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [splitCompareLocked, setSplitCompareLocked] = useState(false);
  const [dreamModalOpen, setDreamModalOpen] = useState(false);
  const [timeTravelOpen, setTimeTravelOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const nextToastId = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  const showToast = useCallback((message: string, opts: ToastOptions = {}) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: ++nextToastId.current, message, undoLabel: opts.undoLabel, onUndo: opts.onUndo });
    toastTimer.current = window.setTimeout(dismissToast, opts.durationMs ?? 5000);
  }, [dismissToast]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const [compareBaseline, setCompareBaseline] = useState(true);
  const [restoredDraft, setRestoredDraft] = useState<RestoredDraft | null>(null);

  const [proactiveUnavailableFor, setProactiveUnavailableFor] = useState<string | null>(null);
  const [pendingNudges, setPendingNudges] = useState<Nudge[]>([]);
  const [simulatedNudges, setSimulatedNudges] = useState<Nudge[]>([]);
  const [historyNudges, setHistoryNudges] = useState<Nudge[]>([]);
  const [intentionsTotal, setIntentionsTotal] = useState<number | null>(null);
  const [intentionsLoadFailed, setIntentionsLoadFailed] = useState(false);
  const [intentions, setIntentions] = useState<ProspectiveIntention[]>([]);
  const [proactiveProfile, setProactiveProfile] = useState<ProactiveProfile | null>(null);
  const [proactivePolicy, setProactivePolicy] = useState<ProactivePolicy | null>(null);
  const [tuckedNudgeIds, setTuckedNudgeIds] = useState<string[]>([]);
  const [evaluatingProactive, setEvaluatingProactive] = useState(false);
  const [proactiveNotice, setProactiveNotice] = useState<string | null>(null);
  const [loadingProactiveInbox, setLoadingProactiveInbox] = useState(false);
  const [openingNudgeSession, setOpeningNudgeSession] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const proactiveScope = useRef<ProactiveScope | null>(null);
  const promotionInFlight = useRef<ProactiveScope | null>(null);

  const [centerMode, setCenterView] = useState<CenterViewMode>("chat");
  const [memoryTarget, setMemoryTarget] = useState(DEFAULT_MEMORY_TARGET);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightPanelTab>("details");
  const [focusedReply, setFocusedReply] = useState<ChatMessage | null>(null);
  const [inspectedSource, setInspectedSource] = useState<SourceInspectTarget | null>(null);

  const [dreamJob, setDreamJob] = useState<{ id: string; running: boolean } | null>(null);
  const dreamJobId = dreamJob?.id ?? null;
  const dreamRunning = dreamJob?.running ?? false;
  const [forgetJobIds, setForgetJobIds] = useState<string[]>([]);
  const [triggeringDream, setTriggeringDream] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipNextSessionFetchRef = useRef<string | null>(null);
  const currentSpaceKey = useRef("");
  const navigationRevision = useRef(0);

  const setActiveSessionId = useCallback((sessionId: string | null) => {
    activeSessionRef.current = sessionId;
    commitActiveSessionId(sessionId);
  }, []);

  const setCenterMode = useCallback((mode: CenterViewMode) => {
    navigationRevision.current++;
    setCenterView(mode);
  }, []);

  const clearRestoredDraft = useCallback((draft: RestoredDraft) => {
    setRestoredDraft((current) => current === draft ? null : current);
  }, []);

  const pickBestSpace = useCallback((list: Space[], preferred?: string) => {
    if (!list.length) return "";
    if (preferred && list.some((s) => spaceKeyOf(s) === preferred)) return preferred;
    const chenMo = list.find((s) => s.namespace === "personal" && s.space_id === "chen_mo");
    if (chenMo) return spaceKeyOf(chenMo);
    const linXi = list.find((s) => s.namespace === "personal" && s.space_id === "lin_xi");
    if (linXi) return spaceKeyOf(linXi);
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
  const namespace = activeSpace?.namespace;
  const spaceId = activeSpace?.space_id;
  const proactiveAvailable = Boolean(activeSpace && proactiveUnavailableFor !== spaceKeyOf(activeSpace));

  const setPendingSnapshot = useCallback((scope: ProactiveScope, nudges: Nudge[], seenAtStart?: Set<string>) => {
    for (const nudge of nudges) scope.seen.add(nudge.nudge_id);
    const history = scope.history;
    setPendingNudges((current) => {
      const newDeliveries = seenAtStart ? current.filter((nudge) => !seenAtStart.has(nudge.nudge_id)) : [];
      const unique = new Map([...newDeliveries, ...nudges].map((nudge) => [nudge.nudge_id, nudge]));
      return prioritizeNudges([...unique.values()].filter((nudge) => nudge.status === "pending" && !history.has(nudge.nudge_id)));
    });
  }, []);

  const hideUnavailableProactive = useCallback((scope: ProactiveScope, err: unknown) => {
    if (!(err instanceof ApiError) || err.status !== 404 ||
      (err.code && err.code !== "NOT_FOUND")) return false;
    setProactiveUnavailableFor(spaceKeyOf(scope.space));
    setPendingNudges([]);
    setSimulatedNudges([]);
    setCenterView((mode) => mode === "inbox" ? "chat" : mode);
    return true;
  }, []);

  const refreshInbox = useCallback(async (scope: ProactiveScope, silent = true) => {
    const request = ++scope.inboxRequest;
    const policyRevision = scope.policyRevision;
    const historyAtStart = new Map(scope.history);
    const seenAtStart = new Set(scope.seen);
    setLoadingProactiveInbox(true);
    const current = () => proactiveScope.current === scope && scope.inboxRequest === request;
    try {
      // Each query has its own limit, so a long history cannot crowd out pending reminders.
      const [pending, all, policy] = await Promise.all([
        api.listNudges(scope.space, { status: "pending", limit: 100 }),
        api.listNudges(scope.space, { status: "all", limit: 100 }),
        api.getProactivePolicy(scope.space),
      ]);
      if (!current()) return true;
      const history = new Map(all.nudges.filter((nudge) => nudge.status !== "pending").map((nudge) => [nudge.nudge_id, nudge]));
      for (const [id, nudge] of scope.history) {
        if (historyAtStart.get(id) !== nudge) history.set(id, nudge);
      }
      scope.history = history;
      setHistoryNudges([...history.values()].sort(newestNudgeFirst));
      setPendingSnapshot(scope, pending.nudges, seenAtStart);
      if (scope.policyRevision === policyRevision) setProactivePolicy(policy);
      if (!scope.ready) {
        scope.ready = true;
        setStreamRevision((revision) => revision + 1);
      }
      return true;
    } catch (err) {
      if (!current() || hideUnavailableProactive(scope, err)) return true;
      if (!silent && scope.ready) setProactiveNotice("轻提醒暂时无法刷新，请稍后再试");
      return false;
    } finally {
      if (current()) setLoadingProactiveInbox(false);
    }
  }, [hideUnavailableProactive, setPendingSnapshot]);

  useEffect(() => {
    setProactiveUnavailableFor(null);
    setPendingNudges([]);
    setSimulatedNudges([]);
    setHistoryNudges([]);
    setIntentions([]);
    setIntentionsTotal(null);
    setIntentionsLoadFailed(false);
    setProactiveProfile(null);
    setProactivePolicy(null);
    setTuckedNudgeIds([]);
    setEvaluatingProactive(false);
    setProactiveNotice(null);
    setLoadingProactiveInbox(false);
    setOpeningNudgeSession(false);
    if (!namespace || !spaceId) return;

    const scope: ProactiveScope = {
      space: { namespace, space_id: spaceId }, seen: new Set(), history: new Map(),
      extrasRequest: 0, inboxRequest: 0, policyRevision: 0, evaluating: false, ready: false,
    };
    proactiveScope.current = scope;
    let retry: number | undefined;
    const initialRefresh = refreshInbox(scope);
    const request = scope.inboxRequest;
    void initialRefresh.then((settled) => {
      if (settled || proactiveScope.current !== scope) return;
      retry = window.setTimeout(() => {
        if (scope.inboxRequest === request) void refreshInbox(scope);
      }, 3000);
    });
    return () => {
      window.clearTimeout(retry);
      proactiveScope.current = null;
    };
  }, [namespace, spaceId, refreshInbox]);

  useEffect(() => {
    if (!proactiveAvailable) return;
    function onVisibilityChange() {
      const scope = proactiveScope.current;
      if (scope && document.visibilityState === "visible") void refreshInbox(scope);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [proactiveAvailable, refreshInbox]);

  useEffect(() => {
    const scope = proactiveScope.current;
    if (!proactiveAvailable || !scope?.ready || scope.space.namespace !== namespace || scope.space.space_id !== spaceId) return;
    const stream = new EventSource(api.proactiveStreamUrl(scope.space));
    stream.addEventListener("snapshot", (event: MessageEvent<string>) => {
      if (proactiveScope.current !== scope) return;
      try {
        setPendingSnapshot(scope, (JSON.parse(event.data) as NudgesResult).nudges);
      } catch { /* An invalid event can be skipped. EventSource reconnects on transport failure. */ }
    });
    stream.addEventListener("nudge", (event: MessageEvent<string>) => {
      if (proactiveScope.current !== scope) return;
      try {
        const nudge = JSON.parse(event.data) as Nudge;
        if (nudge.status !== "pending" || scope.history.has(nudge.nudge_id)) return;
        if (!scope.seen.has(nudge.nudge_id)) {
          scope.seen.add(nudge.nudge_id);
          setTuckedNudgeIds((ids) => ids.filter((id) => id !== nudge.nudge_id));
        }
        setPendingNudges((current) => prioritizeNudges(upsertNudge(current, nudge)));
      } catch { /* Ignore invalid events. */ }
    });
    return () => stream.close();
  }, [namespace, spaceId, proactiveAvailable, setPendingSnapshot, streamRevision]);

  useEffect(() => {
    if (!proactiveNotice) return;
    const timer = window.setTimeout(() => setProactiveNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [proactiveNotice]);

  const refreshMemoryControls = useCallback(async () => {
    if (!namespace || !spaceId) return null;
    const ref = { namespace, space_id: spaceId };
    const key = spaceKeyOf(ref);
    if (currentSpaceKey.current !== key) return null;
    const request = ++controlsRequest.current;
    try {
      const data = await api.getMemoryControls(ref);
      if (currentSpaceKey.current === key && request === controlsRequest.current) {
        setMemoryControls(data);
        setMemoryControlsError(null);
      }
      return data;
    } catch (err) {
      if (currentSpaceKey.current === key && request === controlsRequest.current) setMemoryControlsError((err as Error).message);
      return null;
    }
  }, [namespace, spaceId]);

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
    const ingestJobId = sessRes.active_dream_job_id;
    if (ingestJobId) {
      setDreamJob((tracked) => tracked?.running || tracked?.id === ingestJobId
        ? tracked : { id: ingestJobId, running: true });
    }
    return sessRes.pending_count;
  }, []);

  const refreshAfterRetraction = useEffectEvent(async () => {
    const scope = proactiveScope.current;
    await Promise.all([
      refreshSpacesList(), refreshMemoryControls(), activeSpace ? loadForActiveSpace(activeSpace) : null,
      scope && proactiveAvailable ? refreshInbox(scope) : null,
    ]);
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
    setMemoryControls(null);
    setMemoryControlsError(null);
    setAttachments({});
    setHotMemoryActions({});
    setOverview(null);
    setSessions([]);
    setPendingCount(0);
    setSessionModel(undefined);
    setActiveSessionId(null);
    setMessages([]);
    setRestoredDraft(null);
    setFocusedReply(null);
    setInspectedSource(null);
    setDreamJob(null);
    setMemoryTarget(DEFAULT_MEMORY_TARGET);
    setCenterView("chat");
    void loadForActiveSpace(activeSpace)
      .then((pending) => {
        if (pending !== null && navigationRevision.current === navigation) setRightTab(pending > 0 ? "dream" : "details");
      })
      .catch((err: Error) => setError(err.message));
  }, [activeSpace?.namespace, activeSpace?.space_id, loadForActiveSpace, setActiveSessionId]);

  useEffect(() => {
    void refreshMemoryControls();
  }, [refreshMemoryControls]);

  useEffect(() => {
    const skipFetch = skipNextSessionFetchRef.current === activeSessionId;
    skipNextSessionFetchRef.current = null;
    if (!activeSessionId) {
      setMessages([]);
      setFocusedReply(null);
      setLoadingMessages(false);
      return;
    }
    if (skipFetch) return;
    let alive = true;
    const isCurrent = () => alive && activeSessionRef.current === activeSessionId;
    setLoadingMessages(true);
    void api.getSession(activeSessionId)
      .then((res) => {
        if (!isCurrent()) return;
        setSessions((current) => current.some((session) => session.session_id === activeSessionId)
          ? current : [res.session, ...current]);
        // A turn can finish while this session is being reopened.
        setMessages((prev) => {
          const lastId = res.messages.at(-1)?.id ?? 0;
          return [...res.messages, ...prev.filter((m) => m.session_id === activeSessionId && m.id > lastId)];
        });
        setFocusedReply(res.messages.findLast((m) => m.role === "assistant") ?? null);
      })
      .catch((err: Error) => {
        if (isCurrent()) setError(err.message);
      })
      .finally(() => {
        if (isCurrent()) setLoadingMessages(false);
      });
    return () => { alive = false; };
  }, [activeSessionId]);

  const refreshProactiveExtras = useCallback(async () => {
    const scope = proactiveScope.current;
    if (!scope) return;
    const request = ++scope.extrasRequest;
    const [list, profile] = await Promise.allSettled([
      api.listIntentions(scope.space, { status: "all", limit: 100 }),
      api.getProactiveProfile(scope.space),
    ]);
    if (scope !== proactiveScope.current || request !== scope.extrasRequest) return;
    setIntentionsLoadFailed(list.status === "rejected");
    if (list.status === "fulfilled") {
      setIntentions(list.value.intentions);
      setIntentionsTotal(list.value.total);
    }
    if (profile.status === "fulfilled") setProactiveProfile(profile.value);
    if (list.status === "rejected" || profile.status === "rejected") setProactiveNotice("部分提醒信息暂时无法刷新");
  }, []);

  const refreshSpaceData = useCallback(async (forceKey?: string) => {
    const scope = proactiveScope.current;
    setError(null);
    try {
      await refreshSpacesList(forceKey);
      if (activeSpace && !forceKey) {
        await Promise.all([
          loadForActiveSpace(activeSpace), refreshMemoryControls(),
          scope && proactiveAvailable && proactiveScope.current === scope
            ? Promise.all([refreshInbox(scope), refreshProactiveExtras()]) : null,
        ]);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refreshSpacesList, activeSpace, loadForActiveSpace, refreshMemoryControls, proactiveAvailable, refreshInbox, refreshProactiveExtras]);

  const selectSpace = useCallback((key: string) => {
    if (key !== currentSpaceKey.current) navigationRevision.current++;
    setSelectedSpaceKey(key);
    localStorage.setItem(SPACE_STORAGE_KEY, key);
  }, []);

  const startNewChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setFocusedReply(null);
    setCenterMode("chat");
  }, [setActiveSessionId, setCenterMode]);

  const selectSession = useCallback((sessionId: string) => {
    if (activeSessionRef.current !== sessionId) {
      setMessages([]);
      setFocusedReply(null);
      setLoadingMessages(true);
    }
    setActiveSessionId(sessionId);
    setCenterMode("chat");
    setRightTab("details");
  }, [setActiveSessionId, setCenterMode]);

  const openMemory = useCallback((path = "_index.md") => {
    setMemoryTarget((target) => ({ path, request: target.request + 1 }));
    setCenterMode("memory");
  }, [setCenterMode]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const scope = proactiveScope.current;
    let forgetJobId: string | null | undefined;
    try {
      ({ forget_job_id: forgetJobId } = await api.deleteSession(sessionId));
      if (scope && proactiveScope.current === scope) {
        const unlink = (nudge: Nudge) => nudge.session_id === sessionId ? { ...nudge, session_id: null } : nudge;
        for (const [id, nudge] of scope.history) scope.history.set(id, unlink(nudge));
        setHistoryNudges([...scope.history.values()].sort(newestNudgeFirst));
        setPendingNudges((current) => current.map(unlink));
        setRestoredDraft((current) => current?.sessionId === sessionId ? null : current);
      }
      if (activeSessionRef.current === sessionId) {
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
  }, [activeSpace, loadForActiveSpace, setActiveSessionId]);

  const ensureSession = useCallback(async (space: Space, sessionId: string | null, navigation: number) => {
    if (sessionId) return sessionId;
    const { session } = await api.createSession(space);
    if (currentSpaceKey.current !== spaceKeyOf(space)) return session.session_id;
    setSessions((prev) => [session, ...prev.filter((item) => item.session_id !== session.session_id)]);
    if (navigationRevision.current === navigation && activeSessionRef.current === null) {
      skipNextSessionFetchRef.current = session.session_id;
      setActiveSessionId(session.session_id);
    }
    return session.session_id;
  }, [setActiveSessionId]);

  const refreshAfterTurn = useCallback(async (space: Space) => {
    const [res] = await Promise.all([
      api.listSessions(space), refreshMemoryControls(),
    ]);
    if (currentSpaceKey.current === spaceKeyOf(space)) {
      setSessions(res.sessions);
      setPendingCount(res.pending_count);
      setSessionModel(res.model);
    }
  }, [refreshMemoryControls]);

  const uploadChatAttachment = useCallback(async (sessionId: string | null, file: File, note?: string) => {
    const promoting = promotionInFlight.current !== null && promotionInFlight.current === proactiveScope.current;
    if (!activeSpace || chatBusy.current || promoting || sessionId !== activeSessionRef.current) return false;
    chatBusy.current = true;
    setUploadingAttachment(true);
    setError(null);
    const navigation = navigationRevision.current;
    try {
      const sid = await ensureSession(activeSpace, sessionId, navigation);
      const result = await api.uploadChatAttachment(sid, file, note);
      if (currentSpaceKey.current === result.session.space_key) {
        setAttachments((prev) => ({ ...prev, [result.assistant_message.id]: result.attachment }));
      }
      if (activeSessionRef.current === sid && currentSpaceKey.current === result.session.space_key) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== result.user_message.id && m.id !== result.assistant_message.id),
          result.user_message, result.assistant_message,
        ]);
        setFocusedReply(result.assistant_message);
      }
      await refreshAfterTurn(activeSpace).catch((err: Error) => {
        if (navigationRevision.current === navigation) setError(err.message);
      });
      return navigationRevision.current === navigation;
    } catch (err) {
      if (navigationRevision.current === navigation) setError((err as Error).message);
      return false;
    } finally {
      chatBusy.current = false;
      setUploadingAttachment(false);
    }
  }, [activeSpace, ensureSession, refreshAfterTurn]);

  const sendChatMessage = useCallback(async (rawContent: string, overrideSessionId?: string): Promise<boolean> => {
    const content = rawContent.trim();
    const promoting = promotionInFlight.current !== null && promotionInFlight.current === proactiveScope.current;
    if (!activeSpace || !content || chatBusy.current || (!overrideSessionId && promoting)) return false;
    chatBusy.current = true;
    setSendingMessage(true);

    let sid = overrideSessionId ?? activeSessionRef.current;
    const navigation = navigationRevision.current;
    const sameSpace = () => currentSpaceKey.current === spaceKeyOf(activeSpace);
    const activeChat = () => sameSpace() && activeSessionRef.current === sid;
    const tempUserId = -Date.now();
    const tempAssistantId = tempUserId - 1;
    let persistedUserId: number | null = null;
    try {
      if (activeChat()) {
        setError(null);
        setStreamingStatus("正在检索记忆与历史对话…");
      }
      sid = await ensureSession(activeSpace, sid, navigation);

      const nowIso = new Date().toISOString();
      const optimisticUser: ChatMessage = {
        id: tempUserId,
        session_id: sid,
        role: "user",
        content,
        baseline_reply: null,
        retrieval: null,
        citations: [],
        conversation_hits: [],
        tokens: null,
        latency_ms: null,
        created_at: nowIso,
      };
      const streamingAssistant: ChatMessage = {
        id: tempAssistantId,
        session_id: sid,
        role: "assistant",
        content: "",
        baseline_reply: compareBaseline ? "" : null,
        retrieval: null,
        citations: [],
        conversation_hits: [],
        tokens: null,
        latency_ms: null,
        created_at: nowIso,
      };
      if (activeChat()) setMessages((prev) => [...prev, optimisticUser, streamingAssistant]);

      const result = await api.sendMessageStream(sid, {
        content,
        compare_baseline: compareBaseline,
        verify_raw_sources: true,
      }, {
        onUserMessage: (userMsg) => {
          persistedUserId = userMsg.id;
          if (!activeChat()) return;
          setMessages((prev) => prev.map((m) => m.id === tempUserId ? userMsg : m));
        },
        onStatus: ({ message }) => {
          if (activeChat()) setStreamingStatus(message);
        },
        onContext: ({ retrieval, conversation_hits, hot_memory_action }) => {
          if (sameSpace() && hot_memory_action) {
            setHotMemoryActions((current) => ({ ...current, [tempAssistantId]: hot_memory_action.kind }));
          }
          if (!activeChat()) return;
          setMessages((prev) => prev.map((m) => {
            if (m.id !== tempAssistantId) return m;
            const updated = { ...m, retrieval, conversation_hits };
            setFocusedReply(updated);
            return updated;
          }));
        },
        onDelta: ({ channel, text }) => {
          if (!activeChat() || !text) return;
          setMessages((prev) => prev.map((m) => {
            if (m.id !== tempAssistantId) return m;
            return channel === "baseline"
              ? { ...m, baseline_reply: `${m.baseline_reply ?? ""}${text}` }
              : { ...m, content: `${m.content}${text}` };
          }));
        },
      });

      if (sameSpace()) {
        const action = result.hot_memory_action;
        if (action) {
          setHotMemoryActions((current) => {
            const { [tempAssistantId]: _discard, ...rest } = current;
            return { ...rest, [result.assistant_message.id]: action.kind };
          });
        }
        setSessions((current) => current.map((session) => session.session_id === sid ? result.session : session));
      }
      if (activeChat()) {
        setMessages((prev) => [
          ...prev.filter((m) =>
            m.id !== tempUserId
            && m.id !== tempAssistantId
            && m.id !== result.user_message.id
            && m.id !== result.assistant_message.id),
          result.user_message,
          result.assistant_message,
        ]);
        setFocusedReply(result.assistant_message);
      }

      await refreshAfterTurn(activeSpace).catch((err: Error) => {
        if (activeChat()) setError(err.message);
      });
      return true;
    } catch (err) {
      if (activeChat()) {
        setMessages((prev) => prev.filter((m) => m.id !== tempAssistantId && (persistedUserId !== null || m.id !== tempUserId)));
        setError((err as Error).message);
      }
      return false;
    } finally {
      chatBusy.current = false;
      setSendingMessage(false);
      setStreamingStatus(null);
    }
  }, [activeSpace, compareBaseline, ensureSession, refreshAfterTurn]);

  useEffect(() => {
    if (centerMode === "inbox" && proactiveAvailable) void refreshProactiveExtras();
  }, [centerMode, namespace, spaceId, proactiveAvailable, refreshProactiveExtras]);

  async function changeIntention(change: (ref: SpaceRef) => Promise<unknown>, notice: string) {
    const scope = proactiveScope.current;
    if (!scope) return;
    await change(scope.space);
    if (scope !== proactiveScope.current) return;
    setProactiveNotice(notice);
    await refreshProactiveExtras();
  }

  const createIntention = (input: NewIntention) =>
    changeIntention((ref) => api.createIntention({ ...input, ...ref }), "已添加提醒条件");
  const updateIntentionStatus = (id: string, status: ProspectiveIntention["status"]) =>
    changeIntention((ref) => api.updateIntention(id, { ...ref, status }), "已更新待办状态");
  const deleteIntention = (id: string) =>
    changeIntention((ref) => api.deleteIntention(id, ref), "已删除这条待办");

  async function runProactiveScout() {
    const scope = proactiveScope.current;
    if (!scope) return;
    try {
      const result = await api.runProactiveScout(scope.space);
      if (scope !== proactiveScope.current) return;
      setProactiveNotice(result.findings.length
        ? `发现 ${result.findings.length} 项值得跟进的事，新增 ${result.created_intentions.length} 条待办`
        : "已检查，目前没有发现需要跟进的事");
      await refreshProactiveExtras();
    } catch {
      if (scope === proactiveScope.current) setProactiveNotice("暂时无法排查风险，请稍后再试");
    }
  }

  async function simulateEvent(input: EventDetails) {
    const scope = proactiveScope.current;
    if (!scope) return null;
    const result = await api.ingestProactiveEvent({ ...input, ...scope.space });
    if (scope !== proactiveScope.current) return null;
    if (!result.dry_run) await Promise.all([refreshInbox(scope, false), refreshProactiveExtras()]);
    return scope === proactiveScope.current ? result : null;
  }

  const openInbox = useCallback(() => {
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    setCenterMode("inbox");
    void refreshInbox(scope);
  }, [proactiveAvailable, refreshInbox, setCenterMode]);

  const tuckWhisper = useCallback((nudgeId: string) => {
    setTuckedNudgeIds((current) => current.includes(nudgeId) ? current : [...current, nudgeId]);
  }, []);

  const recordNudgeUpdate = useCallback((scope: ProactiveScope, nudge: Nudge) => {
    if (nudge.status === "pending") {
      scope.history.delete(nudge.nudge_id);
      scope.seen.add(nudge.nudge_id);
      setPendingNudges((current) => prioritizeNudges(upsertNudge(current, nudge)));
      setHistoryNudges((current) => current.filter((item) => item.nudge_id !== nudge.nudge_id));
      return;
    }
    scope.history.set(nudge.nudge_id, nudge);
    setPendingNudges((current) => current.filter((item) => item.nudge_id !== nudge.nudge_id));
    setHistoryNudges((current) => upsertNudge(current, nudge).sort(newestNudgeFirst));
  }, []);

  async function executeNudgeAction(id: string, actionId: string, note?: string) {
    if (id.startsWith("sim_")) {
      setSimulatedNudges((items) => items.filter((item) => item.nudge_id !== id));
      setProactiveNotice("已预览采纳建议的效果");
      return;
    }
    const scope = proactiveScope.current;
    if (!scope) return;
    const result = await api.executeNudgeAction(id, scope.space, actionId, note);
    if (scope !== proactiveScope.current) return;
    recordNudgeUpdate(scope, result.nudge);
    setProactiveNotice(`已采纳「${result.executed_action.label}」${result.hot_memory_id ? "，并记下了这次处理" : ""}`);
    if (result.hot_memory_id) await refreshSpaceData();
    else await refreshProactiveExtras();
  }

  const clearSimulatedNudges = useCallback(() => {
    setSimulatedNudges([]);
    setProactiveNotice(null);
  }, []);

  const simulateProactive = useCallback(async (nowIso: string, label?: string) => {
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    if (scope.evaluating) {
      setProactiveNotice("正在模拟检查轻提醒，请稍候");
      return;
    }
    scope.evaluating = true;
    setEvaluatingProactive(true);
    setProactiveNotice(null);
    try {
      const result = await api.evaluateProactive(scope.space, { now: nowIso, dry_run: true });
      if (proactiveScope.current !== scope) return;
      const sims = result.nudges.map((nudge, idx) => ({
        ...nudge,
        nudge_id: `sim_${Date.now()}_${idx}_${nudge.nudge_id}`,
        status: "pending" as const,
      }));
      setSimulatedNudges(sims);
      if (!sims.length) showToast("该时间点暂无需要打扰你的事项，保持安静");
      setTuckedNudgeIds((current) => current.filter((id) => !id.startsWith("sim_")));
      setProactiveNotice(
        sims.length
          ? `模拟 ${label ?? nowIso.slice(0, 16).replace("T", " ")}：生成 ${sims.length} 条演示提醒（仅预览）`
          : `模拟 ${label ?? nowIso.slice(0, 16).replace("T", " ")}：该时间点保持安静，无须打扰`,
      );
    } catch (err) {
      if (proactiveScope.current === scope && !hideUnavailableProactive(scope, err)) {
        setProactiveNotice(err instanceof Error ? err.message : "暂时无法模拟轻提醒，请稍后再试");
      }
    } finally {
      scope.evaluating = false;
      if (proactiveScope.current === scope) setEvaluatingProactive(false);
    }
  }, [proactiveAvailable, hideUnavailableProactive, showToast]);

  const ackNudge = useCallback(async (nudgeId: string, action: NudgeAck["action"], snoozeUntil?: string, extra?: AckExtra) => {
    if (nudgeId.startsWith("sim_")) {
      setSimulatedNudges((current) => current.filter((item) => item.nudge_id !== nudgeId));
      if (action === "dismissed") showToast("已演练「少提这类」");
      const label = action === "completed" ? "知道了" : action === "snooze" ? "晚点提醒" : action === "dismissed" ? "少提这类" : "已查看";
      setProactiveNotice(`已演练「${label}」（仅预览）`);
      return;
    }
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    let payload: NudgeAck;
    if (action === "snooze") {
      if (!snoozeUntil) throw new Error("请选择下次提醒的时间");
      payload = { ...scope.space, action, reason: extra?.reason, snooze_until: snoozeUntil };
    } else {
      payload = { ...scope.space, action, ...extra };
    }
    try {
      const nudge = await api.ackNudge(nudgeId, payload);
      if (proactiveScope.current !== scope) return;
      recordNudgeUpdate(scope, nudge);
      void refreshProactiveExtras();
      if (action === "dismissed") showToast("已记住偏好，同类提醒将减少打扰");
    } catch (err) {
      if (proactiveScope.current === scope && !hideUnavailableProactive(scope, err)) throw err;
    }
  }, [proactiveAvailable, recordNudgeUpdate, refreshProactiveExtras, hideUnavailableProactive, showToast]);

  const openNudgeSession = useCallback(async (nudgeId: string, initialReply?: string) => {
    if (nudgeId.startsWith("sim_")) {
      const sim = simulatedNudges.find((item) => item.nudge_id === nudgeId);
      setSimulatedNudges((current) => current.filter((item) => item.nudge_id !== nudgeId));
      startNewChat();
      const prompt = initialReply?.trim() || (sim ? `关于「${sim.title}」，帮我结合我的记忆梳理一下准备清单和注意点。` : "");
      if (prompt) await sendChatMessage(prompt);
      return;
    }
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    if (promotionInFlight.current === scope || chatBusy.current) throw new Error("请等待当前对话操作完成");
    const nav = navigationRevision.current;
    promotionInFlight.current = scope;
    setOpeningNudgeSession(true);
    try {
      const res = await api.openNudgeSession(nudgeId, scope.space);
      if (proactiveScope.current !== scope) return;
      const sessionId = res.session.session_id;
      setSessions((current) => [res.session, ...current.filter((session) => session.session_id !== sessionId)]);
      recordNudgeUpdate(scope, res.nudge);
      void refreshProactiveExtras();
      if (navigationRevision.current === nav) {
        skipNextSessionFetchRef.current = sessionId === activeSessionRef.current ? null : sessionId;
        setActiveSessionId(sessionId);
        setMessages(res.messages);
        setLoadingMessages(false);
        setFocusedReply(res.messages.at(-1) ?? null);
        setCenterView("chat");
      }
      if (initialReply?.trim()) {
        const sent = await sendChatMessage(initialReply, sessionId);
        if (!sent && proactiveScope.current === scope) setRestoredDraft({ sessionId, text: initialReply });
      }
    } catch (err) {
      if (proactiveScope.current === scope && !hideUnavailableProactive(scope, err)) throw err;
    } finally {
      if (promotionInFlight.current === scope) promotionInFlight.current = null;
      if (proactiveScope.current === scope) setOpeningNudgeSession(false);
    }
  }, [proactiveAvailable, recordNudgeUpdate, refreshProactiveExtras, sendChatMessage, setActiveSessionId, hideUnavailableProactive, simulatedNudges, startNewChat]);

  const updateProactivePolicy = useCallback(async (patch: Partial<ProactivePolicy>) => {
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    try {
      const policy = await api.updateProactivePolicy(scope.space, patch);
      if (proactiveScope.current !== scope) return;
      scope.policyRevision++;
      setProactivePolicy(policy);
      setStreamRevision((revision) => revision + 1);
    } catch (err) {
      if (proactiveScope.current === scope && !hideUnavailableProactive(scope, err)) throw err;
    }
  }, [proactiveAvailable, hideUnavailableProactive]);

  const evaluateProactive = useCallback(async (silent = false) => {
    const scope = proactiveScope.current;
    if (!scope || !proactiveAvailable) return;
    if (scope.evaluating) {
      if (!silent) setProactiveNotice("正在检查轻提醒，请稍候");
      return;
    }
    scope.evaluating = true;
    if (!silent) {
      setEvaluatingProactive(true);
      setProactiveNotice(null);
    }
    try {
      const result = await api.evaluateProactive(scope.space);
      if (proactiveScope.current !== scope || silent) return;
      const count = result.nudges.filter((nudge) => Date.parse(nudge.deliver_after) <= Date.parse(result.evaluated_at)).length;
      setProactiveNotice(count ? `发现 ${count} 条待查看提醒` : "当前很安静，暂无需要打扰的事项");
    } catch (err) {
      if (proactiveScope.current !== scope || hideUnavailableProactive(scope, err) || silent) return;
      setProactiveNotice(err instanceof ApiError && err.status === 409
        ? "轻提醒正在更新，请稍后再试" : "暂时无法检查轻提醒，请稍后再试");
    } finally {
      scope.evaluating = false;
      if (proactiveScope.current === scope) {
        if (!silent) setEvaluatingProactive(false);
        // Evaluating can expire old reminders. A fresh snapshot includes removals as well as deliveries.
        setStreamRevision((revision) => revision + 1);
        if (centerMode === "inbox") void Promise.all([refreshInbox(scope, silent), refreshProactiveExtras()]);
      }
    }
  }, [centerMode, proactiveAvailable, refreshInbox, refreshProactiveExtras, hideUnavailableProactive]);

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

  const triggerDream = useCallback(async (modeOrForce: boolean | ChatDreamMode = false) => {
    if (!activeSpace || triggeringDream || dreamRunning) return;
    setTriggeringDream(true);
    setError(null);
    setRightTab("dream");
    setRightOpen(true);
    try {
      const res = await api.triggerDream(activeSpace, typeof modeOrForce === "string" ? { mode: modeOrForce } : modeOrForce);
      if (currentSpaceKey.current !== spaceKeyOf(activeSpace)) return;
      setDreamJob({ id: res.job.job_id, running: true });
      await loadForActiveSpace(activeSpace);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTriggeringDream(false);
    }
  }, [activeSpace, triggeringDream, dreamRunning, loadForActiveSpace]);

  const onDreamSettled = useCallback(async () => {
    if (!activeSpace) return;
    const scope = proactiveScope.current;
    setDreamJob((tracked) => tracked && tracked.id === dreamJobId ? { ...tracked, running: false } : tracked);
    try {
      await Promise.all([refreshSpacesList(), loadForActiveSpace(activeSpace), refreshMemoryControls()]);
      if (proactiveAvailable && proactiveScope.current === scope) void evaluateProactive(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeSpace, dreamJobId, proactiveAvailable, evaluateProactive, refreshSpacesList, loadForActiveSpace, refreshMemoryControls]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.session_id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const combinedPendingNudges = useMemo(
    () => [...simulatedNudges, ...pendingNudges],
    [simulatedNudges, pendingNudges],
  );
  const activeWhisper = useMemo(() => {
    if (!proactiveAvailable || proactivePolicy?.enabled === false) return null;
    const nudge = combinedPendingNudges.find((item) => !tuckedNudgeIds.includes(item.nudge_id));
    if (!nudge || (activeSessionId && (nudge.urgency !== "urgent" || activeSession?.source_nudge_id === nudge.nudge_id))) return null;
    return nudge;
  }, [proactiveAvailable, proactivePolicy, combinedPendingNudges, tuckedNudgeIds, activeSessionId, activeSession]);

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
        hotMemoryActions,
        loadingMessages,
        sendingMessage,
        streamingStatus,
        memoryControls: memoryControls?.space_key === selectedSpaceKey ? memoryControls : null,
        memoryControlsError,
        refreshMemoryControls,
        patchFactControl: api.patchFactControl,
        addEntityAlias: api.addEntityAlias,
        deleteEntityAlias: api.deleteEntityAlias,
        addHotMemory: api.addHotMemory,
        dismissHotMemory: api.dismissHotMemory,
        uploadChatAttachment,
        uploadingAttachment,
        attachments,
        splitCompareLocked,
        setSplitCompareLocked,
        dreamModalOpen,
        setDreamModalOpen,
        timeTravelOpen,
        setTimeTravelOpen,
        cmdkOpen,
        setCmdkOpen,
        toast,
        showToast,
        dismissToast,
        compareBaseline,
        setCompareBaseline,
        startNewChat,
        selectSession,
        deleteSession,
        sendChatMessage,
        restoredDraft,
        clearRestoredDraft,
        proactiveAvailable,
        activeView: centerMode === "inbox" ? "proactive" : centerMode === "memory" ? "library" : "chat",
        activeWhisper,
        intentions, intentionsTotal, intentionsLoadFailed, proactiveProfile, refreshProactiveExtras, createIntention, updateIntentionStatus,
        deleteIntention, simulateEvent, runProactiveScout, executeNudgeAction,
        proactiveInbox: { pending: combinedPendingNudges, history: historyNudges },
        pendingNudges: combinedPendingNudges,
        historyNudges,
        proactivePolicy,
        tuckedNudgeIds,
        evaluatingProactive,
        proactiveNotice,
        loadingProactiveInbox,
        openingNudgeSession,
        openInbox,
        tuckWhisper,
        ackNudge,
        openNudgeSession,
        updateProactivePolicy,
        evaluateProactive,
        simulatedNudgeCount: simulatedNudges.length,
        simulateProactive,
        clearSimulatedNudges,
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
