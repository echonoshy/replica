import { useState } from "react";
import { useAppStore } from "@/store/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronRight, Plus, Trash2, RefreshCw, Search } from "lucide-react";
import { createEvergreenMemory, deleteEvergreenMemory, getEvergreenMemories } from "@/api/memory";
import { searchKnowledge } from "@/api/memory";
import { cn } from "@/lib/utils";
import type { EvergreenCategory, EntryType, KnowledgeSearchResult } from "@/types";

export default function MemoryPanel({ style }: { style?: React.CSSProperties }) {
  const { currentUser, currentSession, evergreen, chatContext, setEvergreen } = useAppStore();

  const [expandedSections, setExpandedSections] = useState({
    evergreen: true,
    session: true,
    knowledge: true,
  });

  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [newMemoryCategory, setNewMemoryCategory] = useState<EvergreenCategory>("fact");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState<EntryType | "all">("all");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const handleAddEvergreen = async () => {
    if (!currentUser || !newMemoryContent.trim()) return;
    try {
      await createEvergreenMemory(currentUser.id, {
        category: newMemoryCategory,
        content: newMemoryContent.trim(),
      });
      const { data } = await getEvergreenMemories(currentUser.id);
      setEvergreen(data);
      setNewMemoryContent("");
    } catch (error) {
      console.error("Failed to add evergreen memory:", error);
    }
  };

  const handleDeleteEvergreen = async (id: string) => {
    if (!currentUser) return;
    try {
      await deleteEvergreenMemory(id);
      const { data } = await getEvergreenMemories(currentUser.id);
      setEvergreen(data);
    } catch (error) {
      console.error("Failed to delete evergreen memory:", error);
    }
  };

  const handleRefreshEvergreen = async () => {
    if (!currentUser) return;
    try {
      const { data } = await getEvergreenMemories(currentUser.id);
      setEvergreen(data);
    } catch (error) {
      console.error("Failed to refresh evergreen:", error);
    }
  };

  const handleSearch = async () => {
    if (!currentUser || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const { data } = await searchKnowledge({
        user_id: currentUser.id,
        query: searchQuery.trim(),
        entry_type: searchType === "all" ? undefined : searchType,
        top_k: 10,
      });
      setSearchResults(data);
    } catch (error) {
      console.error("Failed to search knowledge:", error);
    } finally {
      setSearching(false);
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "episode":
        return "bg-info/10 text-info";
      case "event":
        return "bg-success/10 text-success";
      case "foresight":
        return "bg-warning/10 text-warning";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "fact":
        return "bg-info/10 text-info";
      case "preference":
        return "bg-success/10 text-success";
      case "relationship":
        return "bg-warning/10 text-warning";
      case "goal":
        return "bg-primary/10 text-primary";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const injectedEvergreenIds = new Set(chatContext?.evergreen.map((e) => e.id) || []);

  return (
    <div className="flex flex-col h-screen bg-sidebar border-t-4 border-border shrink-0" style={style}>
      <div className="p-4 border-b-4 border-border bg-accent">
        <h2 className="text-sm font-black uppercase tracking-widest text-foreground">记忆系统</h2>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          {/* Layer 1: Evergreen */}
          <Card className="p-4 border-4 border-border shadow-[4px_4px_0px_0px_#111111] bg-white">
            <div
              className="flex items-center justify-between cursor-pointer mb-4"
              onClick={() => toggleSection("evergreen")}
            >
              <div className="flex items-center gap-2">
                {expandedSections.evergreen ? (
                  <ChevronDown className="h-5 w-5" />
                ) : (
                  <ChevronRight className="h-5 w-5" />
                )}
                <h3 className="text-sm font-black uppercase tracking-wider">第一层：长期记忆</h3>
                <Badge variant="default" className="text-[10px] shadow-[2px_2px_0px_0px_#111111]">
                  {evergreen.length}
                </Badge>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 hover:bg-secondary border-2 border-transparent hover:border-border hover:shadow-[2px_2px_0px_0px_#111111]"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRefreshEvergreen();
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {expandedSections.evergreen && (
              <div className="space-y-4">
                {currentUser && (
                  <div className="space-y-3 p-3 bg-muted border-2 border-border rounded-md shadow-[2px_2px_0px_0px_#111111]">
                    <Select
                      value={newMemoryCategory}
                      onValueChange={(v) => setNewMemoryCategory(v as EvergreenCategory)}
                    >
                      <SelectTrigger className="h-10 text-sm font-bold border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-2 border-border shadow-[4px_4px_0px_0px_#111111] font-bold">
                        <SelectItem value="fact">事实 (Fact)</SelectItem>
                        <SelectItem value="preference">偏好 (Preference)</SelectItem>
                        <SelectItem value="relationship">关系 (Relationship)</SelectItem>
                        <SelectItem value="goal">目标 (Goal)</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder="添加新记忆..."
                        value={newMemoryContent}
                        onChange={(e) => setNewMemoryContent(e.target.value)}
                        className="text-sm font-medium border-2 border-border shadow-[2px_2px_0px_0px_#111111]"
                      />
                      <Button
                        size="icon"
                        className="h-10 w-10 shrink-0 border-2 border-border shadow-[2px_2px_0px_0px_#111111]"
                        onClick={handleAddEvergreen}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <ScrollArea className="max-h-[300px]">
                  <div className="space-y-3">
                    {evergreen.map((mem) => (
                      <div
                        key={mem.id}
                        className={cn(
                          "group p-3 rounded-md border-2 border-border text-sm shadow-[2px_2px_0px_0px_#111111] bg-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0px_0px_#111111]",
                          injectedEvergreenIds.has(mem.id) && "border-l-8 border-l-primary bg-primary/5",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <Badge
                              variant="secondary"
                              className={cn(
                                "text-[10px] mb-2 uppercase tracking-wider border-2 border-border shadow-[2px_2px_0px_0px_#111111]",
                                getCategoryColor(mem.category),
                              )}
                            >
                              {mem.category}
                            </Badge>
                            <p className="text-sm font-medium leading-relaxed">{mem.content}</p>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-white border-2 border-transparent hover:border-border hover:shadow-[2px_2px_0px_0px_#111111]"
                            onClick={() => handleDeleteEvergreen(mem.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive group-hover:text-white" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </Card>

          {/* Layer 2: Session Context */}
          <Card className="p-4 border-4 border-border shadow-[4px_4px_0px_0px_#111111] bg-white">
            <div className="flex items-center gap-2 cursor-pointer mb-2" onClick={() => toggleSection("session")}>
              {expandedSections.session ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
              <h3 className="text-sm font-black uppercase tracking-wider">第二层：会话上下文</h3>
            </div>

            {expandedSections.session && currentSession && (
              <div className="space-y-3 text-sm mt-4 p-3 bg-muted border-2 border-border rounded-md shadow-[2px_2px_0px_0px_#111111]">
                <div className="flex justify-between items-center border-b-2 border-border/20 pb-2">
                  <span className="font-bold uppercase tracking-wider">Token 数量:</span>
                  <span className="font-mono font-bold bg-white px-2 py-0.5 border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
                    {currentSession.token_count}
                  </span>
                </div>
                <div className="flex justify-between items-center border-b-2 border-border/20 pb-2">
                  <span className="font-bold uppercase tracking-wider">压缩次数:</span>
                  <span className="font-mono font-bold bg-white px-2 py-0.5 border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
                    {currentSession.compaction_count}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-bold uppercase tracking-wider">状态:</span>
                  {currentSession.token_count === 0 ? (
                    <Badge
                      variant="outline"
                      className="bg-muted text-muted-foreground text-[10px] shadow-[2px_2px_0px_0px_#111111]"
                    >
                      新会话
                    </Badge>
                  ) : currentSession.has_unextracted_messages ? (
                    <Badge
                      variant="default"
                      className="bg-success text-black text-[10px] shadow-[2px_2px_0px_0px_#111111]"
                    >
                      活跃中
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="bg-warning text-black text-[10px] shadow-[2px_2px_0px_0px_#111111]"
                    >
                      已归档记忆
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Layer 3: Knowledge */}
          <Card className="p-4 border-4 border-border shadow-[4px_4px_0px_0px_#111111] bg-white">
            <div className="flex items-center gap-2 cursor-pointer mb-4" onClick={() => toggleSection("knowledge")}>
              {expandedSections.knowledge ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
              <h3 className="text-sm font-black uppercase tracking-wider">第三层：知识库</h3>
            </div>

            {expandedSections.knowledge && (
              <div className="space-y-6">
                {/* Current context */}
                {chatContext && chatContext.knowledge.length > 0 && (
                  <div>
                    <p className="text-sm font-black uppercase tracking-wider mb-3 bg-accent inline-block px-2 py-1 border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
                      本轮检索结果
                    </p>
                    <div className="h-[400px] border-2 border-border rounded-md overflow-hidden">
                      <ScrollArea className="h-full">
                        <div className="space-y-3 p-2">
                          {chatContext.knowledge.map((k) => (
                            <div
                              key={k.id}
                              className="p-3 rounded-md border-2 border-border border-l-8 border-l-info bg-white shadow-[2px_2px_0px_0px_#111111] text-sm transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0px_0px_#111111]"
                            >
                              <div className="flex items-center justify-between mb-2">
                                <Badge
                                  variant="secondary"
                                  className={cn(
                                    "text-[10px] uppercase tracking-wider border-2 border-border shadow-[2px_2px_0px_0px_#111111]",
                                    getTypeColor(k.entry_type),
                                  )}
                                >
                                  {k.entry_type}
                                </Badge>
                                <span className="text-xs font-mono font-bold bg-muted px-1.5 py-0.5 border-2 border-border">
                                  {(k.score * 100).toFixed(1)}%
                                </span>
                              </div>
                              {k.title && <p className="font-bold mb-1">{k.title}</p>}
                              <p className="text-muted-foreground line-clamp-3 font-medium">{k.content}</p>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </div>
                )}

                {/* Manual search */}
                {currentUser && (
                  <div className="space-y-3 p-3 bg-muted border-2 border-border rounded-md shadow-[2px_2px_0px_0px_#111111]">
                    <p className="text-sm font-black uppercase tracking-wider">手动搜索</p>
                    <Select value={searchType} onValueChange={(v) => setSearchType(v as EntryType | "all")}>
                      <SelectTrigger className="h-10 text-sm font-bold border-2 border-border shadow-[2px_2px_0px_0px_#111111] bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-2 border-border shadow-[4px_4px_0px_0px_#111111] font-bold">
                        <SelectItem value="all">所有类型 (All Types)</SelectItem>
                        <SelectItem value="episode">片段 (Episode)</SelectItem>
                        <SelectItem value="event">事件 (Event)</SelectItem>
                        <SelectItem value="foresight">预见 (Foresight)</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder="搜索知识库..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                        className="text-sm font-medium border-2 border-border shadow-[2px_2px_0px_0px_#111111]"
                      />
                      <Button
                        size="icon"
                        className="h-10 w-10 shrink-0 border-2 border-border shadow-[2px_2px_0px_0px_#111111]"
                        onClick={handleSearch}
                        disabled={searching}
                      >
                        <Search className="h-4 w-4" />
                      </Button>
                    </div>

                    {searchResults.length > 0 && (
                      <div className="h-[400px] mt-4 border-2 border-border rounded-md overflow-hidden">
                        <ScrollArea className="h-full">
                          <div className="space-y-3 p-2">
                            {searchResults.map((result) => (
                              <div
                                key={result.id}
                                className="p-3 rounded-md border-2 border-border bg-white shadow-[2px_2px_0px_0px_#111111] text-sm transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0px_0px_#111111]"
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <Badge
                                    variant="secondary"
                                    className={cn(
                                      "text-[10px] uppercase tracking-wider border-2 border-border shadow-[2px_2px_0px_0px_#111111]",
                                      getTypeColor(result.entry_type),
                                    )}
                                  >
                                    {result.entry_type}
                                  </Badge>
                                  <span className="text-xs font-mono font-bold bg-muted px-1.5 py-0.5 border-2 border-border">
                                    {(result.score * 100).toFixed(1)}%
                                  </span>
                                </div>
                                {result.title && <p className="font-bold mb-1">{result.title}</p>}
                                <p className="text-muted-foreground line-clamp-3 font-medium">{result.content}</p>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
