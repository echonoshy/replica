import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChevronLeft, ChevronRight, Copy, Check, Trash2, ChevronDown, ChevronUp, ArrowLeft } from 'lucide-react'
import { getSessions, deleteSession } from '@/api/sessions'
import { getMessages } from '@/api/messages'
import { getUserKnowledge, deleteKnowledgeEntry, getKnowledgeCount } from '@/api/memory'
import { getTables, getTableData } from '@/api/admin'
import { cn } from '@/lib/utils'
import type { Session, Message, KnowledgeEntry, TableInfo, TableDataResponse } from '@/types'

export default function AdminView() {
  const navigate = useNavigate()

  return (
    <div className="h-screen bg-background p-6 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-[size:24px_24px] overflow-hidden">
      <div className="w-[95%] max-w-[1600px] mx-auto h-full flex flex-col bg-white border-4 border-border shadow-[12px_12px_0px_0px_#111111] p-6 rounded-md">
        <div className="flex items-center gap-4 mb-6 border-b-4 border-border pb-4">
          <Button
            variant="default"
            size="sm"
            onClick={() => navigate('/')}
            className="bg-accent text-foreground hover:bg-accent/90 border-2 border-border shadow-[4px_4px_0px_0px_#111111]"
          >
            <ArrowLeft className="h-5 w-5 mr-2" />
            返回主界面
          </Button>
          <h1 className="text-4xl font-black uppercase tracking-widest">管理面板</h1>
        </div>

        <Tabs defaultValue="sessions" className="flex-1 flex flex-col min-h-0">
          <TabsList>
            <TabsTrigger value="sessions">会话管理</TabsTrigger>
            <TabsTrigger value="knowledge">知识库</TabsTrigger>
            <TabsTrigger value="database">数据库</TabsTrigger>
          </TabsList>

          <TabsContent value="sessions" className="flex-1 mt-4 min-h-0">
            <SessionsTab />
          </TabsContent>

          <TabsContent value="knowledge" className="flex-1 mt-4 min-h-0">
            <KnowledgeTab />
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-4 min-h-0">
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
    <div className="grid grid-cols-3 gap-4 h-full min-h-0">
      <Card className="p-4 flex flex-col min-h-0">
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="用户 ID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadSessions()}
          />
          <Button onClick={loadSessions} disabled={loading}>
            加载
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-2">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'p-3 rounded-lg border cursor-pointer hover:bg-muted transition-colors',
                  selectedSession?.id === session.id && 'bg-muted border-primary'
                )}
                onClick={() => handleSelectSession(session)}
              >
                <div className="flex items-center justify-between mb-2">
                  <Badge variant={session.status === 'active' ? 'default' : 'secondary'}>
                    {session.status === 'active' ? '活跃' : '已归档'}
                  </Badge>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation()
                        copyToClipboard(session.id, session.id)
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
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs font-mono mb-1">{session.id.slice(0, 16)}...</p>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{new Date(session.created_at).toLocaleString('zh-CN')}</span>
                  <span>{session.token_count} tokens</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  压缩次数: {session.compaction_count}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </Card>

      <Card className="col-span-2 p-4 flex flex-col min-h-0">
        {selectedSession ? (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">消息时间线</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCompacted(!showCompacted)}
              >
                {showCompacted ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                {showCompacted ? '隐藏' : '显示'} 已压缩
              </Button>
            </div>

            <ScrollArea className="flex-1">
              <div className="space-y-3">
                {filteredMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      'p-3 rounded-lg border',
                      msg.is_compacted && 'bg-muted/50 opacity-60'
                    )}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline">{msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统'}</Badge>
                      {msg.message_type !== 'message' && (
                        <Badge variant={msg.message_type === 'compaction_summary' ? 'destructive' : 'secondary'}>
                          {msg.message_type}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {new Date(msg.created_at).toLocaleString('zh-CN')}
                      </span>
                      <span className="text-xs text-muted-foreground">{msg.token_count} tokens</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            选择一个会话以查看消息
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
    <div className="flex flex-col h-full min-h-0">
      <Card className="p-4 mb-4 shrink-0">
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="用户 ID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadKnowledge()}
          />
          <Button onClick={loadKnowledge} disabled={loading}>
            加载
          </Button>
        </div>

        {stats && (
          <div className="flex gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">情节:</span>{' '}
              <span className="font-semibold">{stats.by_type.episode || 0}</span>
            </div>
            <div>
              <span className="text-muted-foreground">事件:</span>{' '}
              <span className="font-semibold">{stats.by_type.event || 0}</span>
            </div>
            <div>
              <span className="text-muted-foreground">预见:</span>{' '}
              <span className="font-semibold">{stats.by_type.foresight || 0}</span>
            </div>
            <div>
              <span className="text-muted-foreground">总计:</span>{' '}
              <span className="font-semibold">{stats.total || 0}</span>
            </div>
          </div>
        )}
      </Card>

      <div className="flex gap-2 mb-4 shrink-0">
        {(['all', 'episode', 'event', 'foresight'] as const).map((type) => (
          <Button
            key={type}
            variant={typeFilter === type ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setTypeFilter(type)
              setPage(0)
            }}
          >
            {type === 'all' ? '全部' : type === 'episode' ? '情节' : type === 'event' ? '事件' : '预见'}
          </Button>
        ))}
      </div>

      <Card className="flex-1 p-4 flex flex-col min-h-0">
        <ScrollArea className="flex-1">
          <div className="space-y-2">
            {paginatedKnowledge.map((entry) => {
              const isExpanded = expandedIds.has(entry.id)
              return (
                <div key={entry.id} className="p-3 rounded-lg border">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">
                          {entry.entry_type === 'episode' ? '情节' : entry.entry_type === 'event' ? '事件' : '预见'}
                        </Badge>
                        {entry.title && <span className="text-sm font-medium">{entry.title}</span>}
                      </div>
                      <p className={cn('text-sm', !isExpanded && 'line-clamp-2')}>
                        {entry.content}
                      </p>
                      {entry.participants && entry.participants.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          参与者: {entry.participants.join(', ')}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(entry.created_at).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
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
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => handleDelete(entry.id)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一页
            </Button>
            <span className="text-sm text-muted-foreground">
              第 {page + 1} 页，共 {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
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

  const loadTableData = async (tableName: string, offset: number = 0) => {
    try {
      const { data } = await getTableData(tableName, pageSize, offset)
      setTableData(data)
    } catch (error) {
      console.error('Failed to load table data:', error)
    }
  }

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName)
    setPage(0)
    loadTableData(tableName, 0)
  }

  const handlePageChange = (newPage: number) => {
    if (!selectedTable) return
    setPage(newPage)
    loadTableData(selectedTable, newPage * pageSize)
  }

  const totalPages = tableData ? Math.ceil(tableData.total / pageSize) : 0

  return (
    <div className="grid grid-cols-4 gap-4 h-full min-h-0">
      <Card className="p-4 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">数据表</h3>
          <Button size="sm" onClick={loadTables} disabled={loading}>
            加载
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-1">
            {tables.map((table) => (
              <div
                key={table.name}
                className={cn(
                  'p-2 rounded-lg cursor-pointer hover:bg-muted transition-colors',
                  selectedTable === table.name && 'bg-muted'
                )}
                onClick={() => handleSelectTable(table.name)}
              >
                <p className="text-sm font-medium">{table.name}</p>
                <p className="text-xs text-muted-foreground">{table.row_count} 行</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </Card>

      <Card className="col-span-3 p-4 flex flex-col min-h-0">
        {tableData ? (
          <>
            <h3 className="font-semibold mb-4">{tableData.table_name}</h3>

            <ScrollArea className="flex-1">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      {tableData.columns.map((col) => (
                        <th key={col.name} className="text-left p-2 font-medium">
                          <div>{col.name}</div>
                          <div className="text-xs text-muted-foreground font-normal">{(col as any).data_type || (col as any).type}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableData.rows.map((row, idx) => (
                      <tr key={idx} className="border-b hover:bg-muted/50">
                        {tableData.columns.map((col) => (
                          <td key={col.name} className="p-2 max-w-xs truncate">
                            {String(row[col.name] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollArea>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  上一页
                </Button>
                <span className="text-sm text-muted-foreground">
                  第 {page + 1} 页，共 {totalPages} 页（总计 {tableData.total} 行）
                </span>
                <Button
                  variant="outline"
                  size="sm"
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
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            选择一个数据表以查看数据
          </div>
        )}
      </Card>
    </div>
  )
}
