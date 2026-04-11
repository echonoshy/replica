import { useState, useEffect } from "react";
import { useAppStore } from "@/store/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Copy, Check, Trash2, User as UserIcon } from "lucide-react";
import { getUsers, createUser, deleteUser } from "@/api/users";
import { getSessions, createSession, deleteSession } from "@/api/sessions";
import { getMessages } from "@/api/messages";
import { getEvergreenMemories } from "@/api/memory";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";

export default function SessionSidebar() {
  const {
    users,
    currentUser,
    sessions,
    currentSession,
    setUsers,
    setCurrentUser,
    setSessions,
    setCurrentSession,
    setMessages,
    setEvergreen,
  } = useAppStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [newUserDialog, setNewUserDialog] = useState(false);
  const [newUserExtId, setNewUserExtId] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [userHeight, setUserHeight] = useState(360);
  const [isDragging, setIsDragging] = useState(false);
  const [, setClickCount] = useState(0);
  const [isEasterEggActive, setIsEasterEggActive] = useState(false);

  const handleTitleClick = () => {
    setClickCount((prev) => {
      const newCount = prev + 1;
      if (newCount === 5) {
        setIsEasterEggActive(true);
        setTimeout(() => {
          setIsEasterEggActive(false);
          setClickCount(0);
        }, 5000);
      }
      return newCount;
    });
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadUsers = async () => {
    try {
      const { data } = await getUsers();
      setUsers(data);
    } catch (error) {
      console.error("Failed to load users:", error);
    }
  };

  const handleSelectUser = async (user: (typeof users)[0]) => {
    setCurrentUser(user);
    setLoading(true);
    try {
      const [sessionsRes, evergreenRes] = await Promise.all([getSessions(user.id), getEvergreenMemories(user.id)]);
      setSessions(sessionsRes.data);
      setEvergreen(evergreenRes.data);
    } catch (error) {
      console.error("Failed to load user data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async () => {
    if (!newUserExtId.trim()) return;
    try {
      const { data } = await createUser({
        external_id: newUserExtId.trim(),
        name: newUserName.trim() || null,
      });
      await loadUsers();
      setNewUserDialog(false);
      setNewUserExtId("");
      setNewUserName("");
      handleSelectUser(data);
    } catch (error) {
      console.error("Failed to create user:", error);
    }
  };

  const handleDeleteUser = async (userId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this user and all associated data?")) return;
    try {
      await deleteUser(userId);
      await loadUsers();
      if (currentUser?.id === userId) {
        setCurrentUser(null);
      }
    } catch (error) {
      console.error("Failed to delete user:", error);
    }
  };

  const handleSelectSession = async (session: (typeof sessions)[0]) => {
    setCurrentSession(session);
    try {
      const { data } = await getMessages(session.id, 200, 0, true);
      setMessages(data);
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  };

  const handleCreateSession = async () => {
    if (!currentUser) return;
    try {
      const { data } = await createSession(currentUser.id);
      const { data: sessionsData } = await getSessions(currentUser.id);
      setSessions(sessionsData);
      handleSelectSession(data);
    } catch (error) {
      console.error("Failed to create session:", error);
    }
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this session?")) return;
    try {
      await deleteSession(sessionId);
      if (currentUser) {
        const { data } = await getSessions(currentUser.id);
        setSessions(data);
      }
      if (currentSession?.id === sessionId) {
        setCurrentSession(null);
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    // Simple search implementation
    console.log("Search:", searchQuery);
  };

  const handleCopy = async (text: string, id: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startY = e.clientY;
    const startHeight = userHeight;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setUserHeight(Math.max(120, Math.min(600, startHeight + delta)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      className={cn(
        "w-[320px] border-r-4 border-t-4 border-border bg-sidebar flex flex-col h-screen shrink-0",
        isDragging && "select-none",
      )}
    >
      {/* Logo and Title */}
      <div
        className="p-4 border-b-4 border-border bg-primary flex items-center gap-3 cursor-pointer select-none"
        onClick={handleTitleClick}
        title="Click me 5 times for a surprise!"
      >
        <div
          className={cn(
            "w-12 h-12 rounded-lg border-4 border-border bg-white flex items-center justify-center shadow-[4px_4px_0px_0px_#111111] overflow-hidden transition-all duration-500",
            isEasterEggActive && "rotate-180 scale-110 shadow-[6px_6px_0px_0px_#111111]",
          )}
        >
          <span
            className={cn(
              "text-3xl leading-none select-none transition-all duration-500",
              isEasterEggActive && "animate-bounce",
            )}
          >
            {isEasterEggActive ? "🎉" : "👾"}
          </span>
        </div>
        <h1
          className={cn(
            "text-2xl font-mono font-black tracking-widest text-white uppercase transition-all duration-500",
            isEasterEggActive && "text-yellow-300 scale-110 ml-2",
          )}
        >
          {isEasterEggActive ? "SURPRISE!" : "replica"}
        </h1>
      </div>

      {/* Search */}
      <div className="p-4 border-b-4 border-border bg-accent">
        <div className="flex gap-2">
          <Input
            placeholder="搜索用户/会话 ID"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="text-sm border-2 border-border shadow-[2px_2px_0px_0px_#111111]"
          />
          <Button size="icon" variant="default" onClick={handleSearch} className="flex-shrink-0 bg-primary">
            <Search className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Users */}
      <div
        className="border-b-4 border-border bg-background"
        style={{ height: `${userHeight}px`, minHeight: `${userHeight}px` }}
      >
        <div className="flex items-center justify-between px-4 py-3 bg-secondary border-b-2 border-border">
          <h3 className="text-sm font-black uppercase tracking-widest text-foreground">用户</h3>
          <Dialog open={newUserDialog} onOpenChange={setNewUserDialog}>
            <DialogTrigger asChild>
              <Button
                size="icon"
                variant="default"
                className="h-8 w-8 rounded-md bg-primary shadow-[2px_2px_0px_0px_#111111]"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="border-4 border-border shadow-[8px_8px_0px_0px_#111111]">
              <DialogHeader>
                <DialogTitle className="font-black uppercase text-xl">创建新用户</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div>
                  <label className="text-sm font-bold uppercase">外部 ID *</label>
                  <Input
                    value={newUserExtId}
                    onChange={(e) => setNewUserExtId(e.target.value)}
                    placeholder="user_001"
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <label className="text-sm font-bold uppercase">名称（可选）</label>
                  <Input
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="张三"
                    className="mt-1.5"
                  />
                </div>
                <Button onClick={handleCreateUser} className="w-full text-lg">
                  创建用户
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <ScrollArea style={{ height: `${userHeight - 52}px` }}>
          <div className="px-3 py-3 space-y-3">
            {users.map((user) => (
              <div
                key={user.id}
                className={cn(
                  "group flex items-center gap-3 p-3 rounded-md cursor-pointer transition-all border-2 border-transparent",
                  "hover:bg-muted hover:border-border hover:shadow-[4px_4px_0px_0px_#111111]",
                  currentUser?.id === user.id && "bg-accent border-border shadow-[4px_4px_0px_0px_#111111]",
                )}
                onClick={() => handleSelectUser(user)}
              >
                <div className="w-10 h-10 rounded-md border-2 border-border bg-primary flex items-center justify-center flex-shrink-0 shadow-[2px_2px_0px_0px_#111111]">
                  <UserIcon className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate uppercase">{user.name || user.external_id}</p>
                  <p className="text-xs text-muted-foreground truncate font-mono font-bold">{user.id.slice(0, 8)}...</p>
                </div>
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 hover:bg-white border-2 border-transparent hover:border-border hover:shadow-[2px_2px_0px_0px_#111111]"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(user.id, user.id);
                    }}
                  >
                    {copiedId === user.id ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 hover:bg-destructive hover:text-white border-2 border-transparent hover:border-border hover:shadow-[2px_2px_0px_0px_#111111]"
                    onClick={(e) => handleDeleteUser(user.id, e)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive group-hover/btn:text-white" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Resize handle */}
      <div
        className={cn(
          "h-3 cursor-row-resize flex items-center justify-center flex-shrink-0 relative z-10 transition-colors bg-border hover:bg-primary",
          isDragging && "bg-primary",
        )}
        onMouseDown={handleMouseDown}
      >
        <div className={cn("h-1 w-12 bg-white transition-all", "hover:w-16", isDragging && "w-16")} />
      </div>

      {/* Sessions */}
      <div className="flex-1 flex flex-col min-h-0 bg-background">
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-border bg-secondary">
          <h3 className="text-sm font-black uppercase tracking-widest text-foreground">会话</h3>
          <Button
            size="icon"
            variant="default"
            className="h-8 w-8 rounded-md bg-primary shadow-[2px_2px_0px_0px_#111111]"
            onClick={handleCreateSession}
            disabled={!currentUser}
          >
            <Plus className="h-5 w-5" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-3 py-3 space-y-3">
            {!currentUser ? (
              <p className="text-sm font-bold text-muted-foreground text-center py-8 uppercase">请先选择用户</p>
            ) : loading ? (
              <p className="text-sm font-bold text-muted-foreground text-center py-8 uppercase animate-pulse">
                加载中...
              </p>
            ) : sessions.length === 0 ? (
              <p className="text-sm font-bold text-muted-foreground text-center py-8 uppercase">暂无会话</p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "group flex flex-col gap-2 p-3 rounded-md cursor-pointer transition-all border-2 border-transparent relative",
                    "hover:bg-muted hover:border-border hover:shadow-[4px_4px_0px_0px_#111111]",
                    currentSession?.id === session.id && "bg-accent border-border shadow-[4px_4px_0px_0px_#111111]",
                  )}
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-mono flex-1 truncate font-bold">{session.id.slice(0, 12)}...</p>
                    {session.token_count === 0 ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-2 py-0.5 shadow-[2px_2px_0px_0px_#111111] bg-muted text-muted-foreground"
                      >
                        新会话
                      </Badge>
                    ) : session.has_unextracted_messages ? (
                      <Badge
                        variant="default"
                        className="text-[10px] px-2 py-0.5 shadow-[2px_2px_0px_0px_#111111] bg-success text-black"
                      >
                        活跃
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-2 py-0.5 shadow-[2px_2px_0px_0px_#111111] bg-warning text-black"
                      >
                        已归档
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs font-bold text-muted-foreground">
                    <span>{new Date(session.created_at).toLocaleDateString("zh-CN")}</span>
                    <span className="bg-white px-2 py-0.5 border-2 border-border shadow-[2px_2px_0px_0px_#111111] text-foreground">
                      {session.token_count} tokens
                    </span>
                  </div>
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 backdrop-blur-sm p-1 rounded-md border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 hover:bg-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(session.id, session.id);
                      }}
                    >
                      {copiedId === session.id ? (
                        <Check className="h-3 w-3 text-success" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 hover:bg-destructive hover:text-white"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      <Trash2 className="h-3 w-3 text-destructive hover:text-white" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
