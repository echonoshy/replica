import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChevronLeft, ChevronRight, Copy, Check, Trash2, ChevronDown, ChevronUp, ArrowLeft, Filter, X } from 'lucide-react'
import { getSessions, deleteSession } from '@/api/sessions'
import { getMessages } from '@/api/messages'
import { getUserKnowledge, deleteKnowledgeEntry, getKnowledgeCount } from '@/api/memory'
import { getTables, getTableData } from '@/api/admin'
import { cn } from '@/lib/utils'
import type { Session, Message, KnowledgeEntry, TableInfo, TableDataResponse } from '@/types'
import type { TableFilter } from '@/api/admin'

// 抽取复用的新粗野主义风格类名
const brutalistCard = "border-2 border-border shadow-[4px_4px_0px_0px_#111111] bg-white rounded-md"
const brutalistButton = "border-2 border-border shadow-[2px_2px_0px_0px_#111111] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_#111111] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
const brutalistInput = "border-2 border-border shadow-[2px_2px_0px_0px_#111111] focus-visible:ring-0 focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] focus-visible:shadow-[1px_1px_0px_0px_#111111] transition-all rounded-md"
const brutalistItem = "border-2 border-border shadow-[2px_2px_0px_0px_#111111] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_#111111] transition-all bg-white rounded-md"

export default function AdminView() {
  const navigate = useNavigate()

  return (
    <div className="h-screen bg-background bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-[size:24px_24px] overflow-hidden font-sans">
      <div className="w-full h-full flex flex-col bg-white p-6">
        <div className="flex items-center gap-4 mb-6 border-b-4 border-border pb-6">
          <Button
            variant="default"
            size="sm"
            onClick={() => navigate('/')}
            className={cn("bg-white text-foreground hover:bg-gray-50", brutalistButton)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            <span className="font-bold text-sm">返回主界面</span>
          </Button>
          <h1 className="text-2xl font-extrabold uppercase tracking-widest ml-2">管理面板 <span className="text-muted-foreground text-xl">/ ADMIN</span></h1>
        </div>

        <Tabs defaultValue="sessions" className="flex-1 flex flex-col min-h-0">
          <TabsList className="bg-[#fef08a] border-2 border-border shadow-[4px_4px_0px_0px_#111111] p-1 h-auto rounded-md inline-flex w-fit mb-6">
            <TabsTrigger value="sessions" className="data-[state=active]:bg-black data-[state=active]:text-white data-[state=active]:shadow-none rounded-sm px-5 py-1.5 text-sm font-bold transition-all">会话管理</TabsTrigger>
            <TabsTrigger value="knowledge" className="data-[state=active]:bg-black data-[state=active]:text-white data-[state=active]:shadow-none rounded-sm px-5 py-1.5 text-sm font-bold transition-all">知识库</TabsTrigger>
            <TabsTrigger value="database" className="data-[state=active]:bg-black data-[state=active]:text-white data-[state=active]:shadow-none rounded-sm px-5 py-1.5 text-sm font-bold transition-all">数据库</TabsTrigger>
          </TabsList>

          <TabsContent value="sessions" className="flex-1 mt-0 min-h-0 data-[state=active]:flex flex-col">
            <SessionsTab />
          </TabsContent>

          <TabsContent value="knowledge" className="flex-1 mt-0 min-h-0 data-[state=active]:flex flex-col">
            <KnowledgeTab />
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-0 min-h-0 data-[state=active]:flex flex-col">
            <DatabaseTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function SessionsTab() {
  const [userId, setUserId] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [showCompacted, setShowCompacted] = useState(true)
  const [loading, setLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const loadSessions = async () => {
    if (!userId.trim()) return
    setLoading(true)
    try {
      const { data } = await getSessions(userId.trim())
      setSessions(data)
    } catch (error) {
      console.error('Failed to load sessions:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadMessages = async (sessionId: string) => {
    try {
      const { data } = await getMessages(sessionId, 200, 0, true)
      setMessages(data)
    } catch (error) {
      console.error('Failed to load messages:', error)
    }
  }

  const handleSelectSession = (session: Session) => {
    setSelectedSession(session)
    loadMessages(session.id)
  }

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('Delete this session?')) return
    try {
      await deleteSession(sessionId)
      loadSessions()
      if (selectedSession?.id === sessionId) {
        setSelectedSession(null)
        setMessages([])
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  }

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  const filteredMessages = showCompacted ? messages : messages.filter((m) => !m.is_compacted)

  return (
    <div className="grid grid-cols-3 gap-6 h-full min-h-0">
      <Card className={cn("p-4 flex flex-col min-h-0 bg-[#f8fafc]", brutalistCard)}>
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="输入用户 ID..."
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadSessions()}
            className={cn("text-sm", brutalistInput)}
          />
          <Button onClick={loadSessions} disabled={loading} className={cn("font-bold text-sm bg-[#3b82f6] text-white hover:bg-blue-600", brutalistButton)}>
            加载
          </Button>
        </div>

        <ScrollArea className="flex-1 pr-3 -mr-3">
          <div className="space-y-3 pb-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'p-3 cursor-pointer',
                  brutalistItem,
                  selectedSession?.id === session.id ? 'bg-[#bfdbfe] border-black shadow-none translate-x-[2px] translate-y-[2px]' : 'bg-white'
                )}
                onClick={() => handleSelectSession(session)}
              >
                <div className="flex items-center justify-between mb-2">
                  <Badge variant={session.status === 'active' ? 'default' : 'secondary'} className={cn("border-2 border-border font-bold text-xs", session.status === 'active' ? 'bg-black text-white' : 'bg-gray-200 text-black')}>
                    {session.status === 'active' ? '活跃' : '已归档'}
                  </Badge>
                  <div className="flex gap-1.5">
                    <Button
                      size="icon"
                      variant="outline"
                      className={cn("h-6 w-6 bg-white", brutalistButton)}
                      onClick={(e) => {
                        e.stopPropagation()
                        copyToClipboard(session.id, session.id)
                      }}
                    >
                      {copiedId === session.id ? (
                        <Check className="h-3 w-3 text-green-600 font-bold" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      className={cn("h-6 w-6 bg-white hover:bg-red-50 hover:text-red-600", brutalistButton)}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs font-mono font-bold mb-2 bg-white/50 p-1 rounded border-2 border-border inline-block">{session.id.slice(0, 16)}...</p>
                <div className="flex justify-between text-xs font-medium text-muted-foreground mt-1">
                  <span>{new Date(session.created_at).toLocaleString('zh-CN')}</span>
                  <span className="bg-white/50 px-1.5 py-0.5 rounded border-2 border-border text-black">{session.token_count} tk</span>
                </div>
                <div className="text-xs font-medium text-muted-foreground mt-2 flex items-center gap-2">
                  <span>压缩次数:</span>
                  <Badge variant="outline" className="border-2 border-border font-bold text-[10px] px-1.5 py-0">{session.compaction_count}</Badge>
                </div>
              </div>
            ))}
            {sessions.length === 0 && !loading && (
              <div className="text-center py-8 text-sm text-muted-foreground font-bold border-2 border-dashed border-border rounded-lg bg-white">
                暂无会话数据
              </div>
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className={cn("col-span-2 p-4 flex flex-col min-h-0 bg-[#fdfde8]", brutalistCard)}>
        {selectedSession ? (
          <>
            <div className="flex items-center justify-between mb-4 pb-3 border-b-4 border-border">
              <h3 className="text-lg font-extrabold uppercase tracking-wide">消息时间线</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCompacted(!showCompacted)}
                className={cn("font-bold text-xs bg-white", brutalistButton)}
              >
                {showCompacted ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                {showCompacted ? '隐藏' : '显示'} 已压缩
              </Button>
            </div>

            <ScrollArea className="flex-1 pr-3 -mr-3">
              <div className="space-y-3 pb-4">
                {filteredMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      'p-3',
                      brutalistItem,
                      msg.is_compacted && 'bg-gray-50 opacity-70 border-dashed'
                    )}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className={cn(
                        "border-2 border-border font-bold text-xs px-2 py-0.5",
                        msg.role === 'user' ? 'bg-[#bfdbfe]' : msg.role === 'assistant' ? 'bg-[#bbf7d0]' : 'bg-gray-200'
                      )}>
                        {msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统'}
                      </Badge>
                      {msg.message_type !== 'message' && (
                        <Badge variant="outline" className={cn(
                          "border-2 border-border font-bold text-xs px-2 py-0.5",
                          msg.message_type === 'compaction_summary' ? 'bg-[#fecdd3] text-red-800' : 'bg-[#fef08a]'
                        )}>
                          {msg.message_type}
                        </Badge>
                      )}
                      <span className="text-xs font-bold text-muted-foreground ml-auto bg-white/50 px-1.5 py-0.5 rounded border-2 border-border">
                        {new Date(msg.created_at).toLocaleString('zh-CN')}
                      </span>
                      <span className="text-xs font-bold text-muted-foreground bg-white/50 px-1.5 py-0.5 rounded border-2 border-border">
                        {msg.token_count} tk
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap leading-relaxed font-medium">{msg.content}</p>
                  </div>
                ))}
                {filteredMessages.length === 0 && (
                  <div className="text-center py-8 text-sm text-muted-foreground font-bold border-2 border-dashed border-border rounded-lg bg-white">
                    暂无消息记录
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border-4 border-dashed border-border rounded-xl m-4 bg-white/50">
            <div className="text-4xl mb-3">💬</div>
            <h3 className="text-xl font-extrabold text-black">选择一个会话</h3>
            <p className="font-medium text-sm mt-1">在左侧列表中点击会话以查看详细消息记录</p>
          </div>
        )}
      </Card>
    </div>
  )
}

function KnowledgeTab() {
  const [userId, setUserId] = useState('')
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [stats, setStats] = useState<{ total: number; by_type: { episode?: number; event?: number; foresight?: number } } | null>(null)
  const [page, setPage] = useState(0)
  const [typeFilter, setTypeFilter] = useState<'all' | 'episode' | 'event' | 'foresight'>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const pageSize = 50

  const loadKnowledge = async () => {
    if (!userId.trim()) return
    setLoading(true)
    try {
      const [knowledgeRes, countRes] = await Promise.all([
        getUserKnowledge(userId.trim(), 200),
        getKnowledgeCount(userId.trim()),
      ])
      setKnowledge(knowledgeRes.data)
      setStats(countRes.data)
      setPage(0)
    } catch (error) {
      console.error('Failed to load knowledge:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this knowledge entry?')) return
    try {
      await deleteKnowledgeEntry(id)
      loadKnowledge()
    } catch (error) {
      console.error('Failed to delete knowledge:', error)
    }
  }

  const toggleExpand = (id: string) => {
    const newSet = new Set(expandedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setExpandedIds(newSet)
  }

  const filteredKnowledge = typeFilter === 'all'
    ? knowledge
    : knowledge.filter((k) => k.entry_type === typeFilter)

  const paginatedKnowledge = filteredKnowledge.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(filteredKnowledge.length / pageSize)

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      <div className="flex gap-4 shrink-0">
        <Card className={cn("p-4 flex-1 bg-[#fdf4ff]", brutalistCard)}>
          <div className="flex gap-2">
            <Input
              placeholder="输入用户 ID..."
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadKnowledge()}
              className={cn("text-sm bg-white", brutalistInput)}
            />
            <Button onClick={loadKnowledge} disabled={loading} className={cn("font-bold text-sm bg-[#c084fc] text-white hover:bg-purple-600", brutalistButton)}>
              加载知识库
            </Button>
          </div>
        </Card>

        {stats && (
          <Card className={cn("p-4 flex items-center gap-5 bg-[#fdf4ff]", brutalistCard)}>
            <div className="flex flex-col items-center px-3 border-r-2 border-border">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-0.5">总计</span>
              <span className="text-xl font-extrabold">{stats.total || 0}</span>
            </div>
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold text-muted-foreground mb-0.5">情节</span>
                <Badge variant="outline" className="border-2 border-border font-bold bg-[#bfdbfe] text-blue-900 text-sm px-2 py-0.5">{stats.by_type.episode || 0}</Badge>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold text-muted-foreground mb-0.5">事件</span>
                <Badge variant="outline" className="border-2 border-border font-bold bg-[#bbf7d0] text-green-900 text-sm px-2 py-0.5">{stats.by_type.event || 0}</Badge>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold text-muted-foreground mb-0.5">预见</span>
                <Badge variant="outline" className="border-2 border-border font-bold bg-[#e9d5ff] text-purple-900 text-sm px-2 py-0.5">{stats.by_type.foresight || 0}</Badge>
              </div>
            </div>
          </Card>
        )}
      </div>

      <div className="flex gap-2 shrink-0">
        {(['all', 'episode', 'event', 'foresight'] as const).map((type) => (
          <Button
            key={type}
            variant="outline"
            className={cn(
              "font-bold px-4 text-sm",
              brutalistButton,
              typeFilter === type ? 'bg-black text-white hover:bg-black hover:text-white translate-x-[2px] translate-y-[2px] shadow-none' : 'bg-white'
            )}
            onClick={() => {
              setTypeFilter(type)
              setPage(0)
            }}
          >
            {type === 'all' ? '全部记录' : type === 'episode' ? '情节 (Episode)' : type === 'event' ? '事件 (Event)' : '预见 (Foresight)'}
          </Button>
        ))}
      </div>

      <Card className={cn("flex-1 p-4 flex flex-col min-h-0 bg-white", brutalistCard)}>
        <ScrollArea className="flex-1 pr-3 -mr-3">
          <div className="space-y-3 pb-4">
            {paginatedKnowledge.map((entry) => {
              const isExpanded = expandedIds.has(entry.id)
              return (
                <div key={entry.id} className={cn("p-3", brutalistItem)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className={cn(
                          "border-2 border-border font-bold px-2 py-0.5 text-xs",
                          entry.entry_type === 'episode' ? 'bg-[#bfdbfe]' : entry.entry_type === 'event' ? 'bg-[#bbf7d0]' : 'bg-[#e9d5ff]'
                        )}>
                          {entry.entry_type === 'episode' ? '情节' : entry.entry_type === 'event' ? '事件' : '预见'}
                        </Badge>
                        {entry.title && <span className="text-base font-extrabold">{entry.title}</span>}
                      </div>
                      <div className={cn(
                        'text-sm font-medium leading-relaxed bg-gray-50 p-2 rounded border-2 border-border',
                        !isExpanded && 'line-clamp-2'
                      )}>
                        {entry.content}
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        {entry.participants && entry.participants.length > 0 && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-muted-foreground">参与者:</span>
                            <div className="flex gap-1 flex-wrap">
                              {entry.participants.map(p => (
                                <Badge key={p} variant="outline" className="border-2 border-border font-bold bg-white text-xs py-0">{p}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="text-xs font-bold text-muted-foreground bg-gray-100 px-1.5 py-0.5 rounded border-2 border-border ml-auto">
                          {new Date(entry.created_at).toLocaleString('zh-CN')}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button
                        size="icon"
                        variant="outline"
                        className={cn("h-7 w-7 bg-white", brutalistButton)}
                        onClick={() => toggleExpand(entry.id)}
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        className={cn("h-7 w-7 bg-white hover:bg-red-50 hover:text-red-600", brutalistButton)}
                        onClick={() => handleDelete(entry.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
            {paginatedKnowledge.length === 0 && !loading && (
              <div className="text-center py-12 text-sm text-muted-foreground font-bold border-4 border-dashed border-border rounded-xl m-2 bg-gray-50">
                <h3 className="text-lg font-extrabold text-black">暂无知识库记录</h3>
                <p className="font-medium mt-1">输入用户 ID 并加载以查看数据</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t-4 border-border">
            <Button
              variant="outline"
              size="sm"
              className={cn("font-bold text-xs bg-white", brutalistButton)}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一页
            </Button>
            <span className="text-sm font-extrabold bg-gray-100 px-3 py-1 rounded border-2 border-border">
              第 {page + 1} 页 <span className="text-muted-foreground mx-1">/</span> 共 {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              className={cn("font-bold text-xs bg-white", brutalistButton)}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
            >
              下一页
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

function DatabaseTab() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableData, setTableData] = useState<TableDataResponse | null>(null)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<TableFilter | null>(null)
  const [filterField, setFilterField] = useState('')
  const [filterOp, setFilterOp] = useState<'eq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte'>('eq')
  const [filterValue, setFilterValue] = useState('')
  const [selectedRow, setSelectedRow] = useState<Record<string, any> | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)

  const pageSize = 50

  const loadTables = async () => {
    setLoading(true)
    try {
      const { data } = await getTables()
      setTables(data.tables)
    } catch (error) {
      console.error('Failed to load tables:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadTableData = async (tableName: string, offset: number = 0, currentFilter: TableFilter | null = null) => {
    try {
      const { data } = await getTableData(tableName, pageSize, offset, currentFilter || undefined)
      setTableData(data)
    } catch (error) {
      console.error('Failed to load table data:', error)
    }
  }

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName)
    setPage(0)
    setFilter(null)
    setFilterField('')
    setFilterValue('')
    loadTableData(tableName, 0, null)
  }

  const handlePageChange = (newPage: number) => {
    if (!selectedTable) return
    setPage(newPage)
    loadTableData(selectedTable, newPage * pageSize, filter)
  }

  const handleApplyFilter = () => {
    if (!selectedTable || !filterField || !filterValue) return
    const newFilter: TableFilter = { field: filterField, op: filterOp, value: filterValue }
    setFilter(newFilter)
    setPage(0)
    loadTableData(selectedTable, 0, newFilter)
  }

  const handleClearFilter = () => {
    if (!selectedTable) return
    setFilter(null)
    setFilterField('')
    setFilterValue('')
    setPage(0)
    loadTableData(selectedTable, 0, null)
  }

  const handleRowClick = (row: Record<string, any>) => {
    setSelectedRow(row)
    setIsDetailOpen(true)
  }

  const totalPages = tableData ? Math.ceil(tableData.total / pageSize) : 0

  return (
    <div className="grid grid-cols-4 gap-4 h-full min-h-0">
      <Card className={cn("p-4 flex flex-col min-h-0 bg-[#f0fdf4]", brutalistCard)}>
        <div className="flex items-center justify-between mb-4 pb-3 border-b-4 border-border">
          <h3 className="text-lg font-extrabold uppercase tracking-wide">数据表</h3>
          <Button size="sm" onClick={loadTables} disabled={loading} className={cn("font-bold text-xs bg-[#22c55e] text-white hover:bg-green-600", brutalistButton)}>
            加载列表
          </Button>
        </div>

        <ScrollArea className="flex-1 pr-3 -mr-3">
          <div className="space-y-2 pb-4">
            {tables.map((table) => (
              <div
                key={table.name}
                className={cn(
                  'p-2.5 cursor-pointer flex justify-between items-center',
                  brutalistItem,
                  selectedTable === table.name ? 'bg-black text-white border-black shadow-none translate-x-[2px] translate-y-[2px]' : 'bg-white'
                )}
                onClick={() => handleSelectTable(table.name)}
              >
                <p className="text-sm font-bold">{table.name}</p>
                <Badge variant="outline" className={cn(
                  "border-2 font-bold text-[10px] px-1.5 py-0",
                  selectedTable === table.name ? 'border-white text-white bg-transparent' : 'border-border bg-gray-100 text-black'
                )}>
                  {table.row_count} 行
                </Badge>
              </div>
            ))}
            {tables.length === 0 && !loading && (
              <div className="text-center py-8 text-sm text-muted-foreground font-bold border-2 border-dashed border-border rounded-lg bg-white">
                点击加载获取数据表
              </div>
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className={cn("col-span-3 p-4 flex flex-col min-h-0 overflow-hidden bg-white", brutalistCard)}>
        {tableData ? (
          <>
            <div className="flex items-center justify-between mb-4 pb-3 border-b-4 border-border shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-extrabold bg-[#fef08a] px-3 py-0.5 rounded border-2 border-border">{tableData.table_name}</h3>
                {filter && (
                  <Badge variant="outline" className="gap-1 border-2 border-border font-bold text-xs px-2 py-0.5 bg-yellow-50">
                    <Filter className="h-3 w-3" />
                    {filter.field} {filter.op} "{filter.value}"
                  </Badge>
                )}
              </div>
            </div>

            <div className={cn("p-3 mb-4 shrink-0 bg-[#f8fafc]", brutalistCard)}>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs font-bold text-black mb-1.5 block uppercase tracking-wider">筛选字段</label>
                  <Select value={filterField} onValueChange={setFilterField}>
                    <SelectTrigger className={cn("h-8 text-sm bg-white", brutalistInput)}>
                      <SelectValue placeholder="选择字段" />
                    </SelectTrigger>
                    <SelectContent className="border-2 border-border shadow-[4px_4px_0px_0px_#111111]">
                      {tableData.columns.map((col) => (
                        <SelectItem key={col.name} value={col.name} className="font-medium text-sm cursor-pointer focus:bg-gray-100">
                          {col.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32">
                  <label className="text-xs font-bold text-black mb-1.5 block uppercase tracking-wider">操作符</label>
                  <Select value={filterOp} onValueChange={(v) => setFilterOp(v as any)}>
                    <SelectTrigger className={cn("h-8 text-sm bg-white", brutalistInput)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-2 border-border shadow-[4px_4px_0px_0px_#111111]">
                      <SelectItem value="eq" className="font-medium text-sm cursor-pointer focus:bg-gray-100">等于 (=)</SelectItem>
                      <SelectItem value="contains" className="font-medium text-sm cursor-pointer focus:bg-gray-100">包含</SelectItem>
                      <SelectItem value="gt" className="font-medium text-sm cursor-pointer focus:bg-gray-100">大于 (&gt;)</SelectItem>
                      <SelectItem value="lt" className="font-medium text-sm cursor-pointer focus:bg-gray-100">小于 (&lt;)</SelectItem>
                      <SelectItem value="gte" className="font-medium text-sm cursor-pointer focus:bg-gray-100">大于等于 (≥)</SelectItem>
                      <SelectItem value="lte" className="font-medium text-sm cursor-pointer focus:bg-gray-100">小于等于 (≤)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <label className="text-xs font-bold text-black mb-1.5 block uppercase tracking-wider">筛选值</label>
                  <Input
                    placeholder="输入要筛选的值..."
                    value={filterValue}
                    onChange={(e) => setFilterValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleApplyFilter()}
                    className={cn("h-8 text-sm bg-white", brutalistInput)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleApplyFilter} disabled={!filterField || !filterValue} className={cn("h-8 font-bold text-xs bg-[#3b82f6] text-white hover:bg-blue-600", brutalistButton)}>
                    <Filter className="h-3 w-3 mr-1" />
                    应用筛选
                  </Button>
                  {filter && (
                    <Button size="sm" onClick={handleClearFilter} variant="outline" className={cn("h-8 font-bold text-xs bg-white text-red-600 hover:bg-red-50", brutalistButton)}>
                      <X className="h-3 w-3 mr-1" />
                      清除
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-auto border-2 border-border rounded-md shadow-[4px_4px_0px_0px_#111111] bg-white">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-[#f1f5f9] z-10 border-b-2 border-border shadow-sm">
                  <tr>
                    {tableData.columns.map((col) => (
                      <th key={col.name} className="text-left p-3 font-extrabold whitespace-nowrap min-w-[120px] border-r-2 border-border last:border-r-0">
                        <div className="text-sm">{col.name}</div>
                        <div className="text-[10px] text-muted-foreground font-bold mt-0.5 uppercase tracking-wider">{(col as any).data_type || (col as any).type}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.rows.map((row, idx) => (
                    <tr
                      key={idx}
                      className="border-b-2 border-border hover:bg-[#fef08a] cursor-pointer transition-colors"
                      onClick={() => handleRowClick(row)}
                    >
                      {tableData.columns.map((col) => (
                        <td key={col.name} className="p-3 border-r-2 border-border last:border-r-0 min-w-[120px] font-medium text-sm">
                          <div className="max-w-[300px] truncate">
                            {typeof row[col.name] === 'object' && row[col.name] !== null
                              ? JSON.stringify(row[col.name])
                              : String(row[col.name] ?? '')}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                  {tableData.rows.length === 0 && (
                    <tr>
                      <td colSpan={tableData.columns.length} className="p-8 text-center text-sm text-muted-foreground font-bold">
                        没有找到匹配的数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t-4 border-border shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("font-bold text-xs bg-white", brutalistButton)}
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  上一页
                </Button>
                <span className="text-sm font-extrabold bg-gray-100 px-3 py-1 rounded border-2 border-border">
                  第 {page + 1} 页 <span className="text-muted-foreground mx-1">/</span> 共 {totalPages} 页
                  <span className="ml-3 text-xs text-muted-foreground font-bold">（总计 {tableData.total} 行）</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("font-bold text-xs bg-white", brutalistButton)}
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page === totalPages - 1}
                >
                  下一页
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border-4 border-dashed border-border rounded-xl m-2 bg-gray-50">
            <div className="text-4xl mb-3">🗄️</div>
            <h3 className="text-lg font-extrabold text-black">选择一个数据表</h3>
            <p className="font-medium text-sm mt-1">在左侧列表中点击表名以查看数据</p>
          </div>
        )}

        <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
          <DialogContent className="max-w-6xl max-h-[80vh] flex flex-col border-4 border-border shadow-[8px_8px_0px_0px_#111111] p-0 !rounded-2xl bg-white">
            <DialogHeader className="p-4 border-b-4 border-border bg-[#fef08a] shrink-0">
              <DialogTitle className="text-lg font-extrabold uppercase tracking-widest">记录详情</DialogTitle>
            </DialogHeader>
            <ScrollArea className="flex-1 p-4 overflow-auto">
              {selectedRow && tableData && (
                <div className="divide-y-2 divide-border border-2 border-border rounded-xl overflow-hidden bg-white shadow-sm">
                  {tableData.columns.map((col) => (
                    <div key={col.name} className="flex flex-col sm:flex-row sm:items-start p-3 hover:bg-gray-50 transition-colors">
                      <div className="w-full sm:w-1/3 shrink-0 mb-1.5 sm:mb-0 pr-4">
                        <div className="font-extrabold text-sm text-black mb-1">{col.name}</div>
                        <Badge variant="outline" className="border-2 border-border font-bold bg-white text-[10px] px-1.5 py-0">
                          {(col as any).data_type || (col as any).type}
                        </Badge>
                      </div>
                      <div className="flex-1 min-w-0">
                        {typeof selectedRow[col.name] === 'object' && selectedRow[col.name] !== null ? (
                          <pre className="whitespace-pre-wrap break-words font-mono text-xs bg-gray-100 p-3 rounded-lg border-2 border-border max-h-[300px] overflow-auto">
                            {JSON.stringify(selectedRow[col.name], null, 2)}
                          </pre>
                        ) : (
                          <div className="whitespace-pre-wrap break-words text-sm font-medium pt-0.5 max-h-[300px] overflow-auto">
                            {String(selectedRow[col.name] ?? '')}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  )
}
