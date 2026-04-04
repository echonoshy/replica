import { useState, useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Plus, Search, Copy, Check, Trash2, User as UserIcon } from 'lucide-react'
import { getUsers, createUser, deleteUser } from '@/api/users'
import { getSessions, createSession, deleteSession } from '@/api/sessions'
import { getMessages } from '@/api/messages'
import { getEvergreenMemories } from '@/api/memory'
import { cn } from '@/lib/utils'

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
  } = useAppStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [newUserDialog, setNewUserDialog] = useState(false)
  const [newUserExtId, setNewUserExtId] = useState('')
  const [newUserName, setNewUserName] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadUsers()
  }, [])

  const loadUsers = async () => {
    try {
      const { data } = await getUsers()
      setUsers(data)
    } catch (error) {
      console.error('Failed to load users:', error)
    }
  }

  const handleSelectUser = async (user: typeof users[0]) => {
    setCurrentUser(user)
    setLoading(true)
    try {
      const [sessionsRes, evergreenRes] = await Promise.all([
        getSessions(user.id),
        getEvergreenMemories(user.id),
      ])
      setSessions(sessionsRes.data)
      setEvergreen(evergreenRes.data)
    } catch (error) {
      console.error('Failed to load user data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateUser = async () => {
    if (!newUserExtId.trim()) return
    try {
      const { data } = await createUser({
        external_id: newUserExtId.trim(),
        name: newUserName.trim() || null,
      })
      await loadUsers()
      setNewUserDialog(false)
      setNewUserExtId('')
      setNewUserName('')
      handleSelectUser(data)
    } catch (error) {
      console.error('Failed to create user:', error)
    }
  }

  const handleDeleteUser = async (userId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this user and all associated data?')) return
    try {
      await deleteUser(userId)
      await loadUsers()
      if (currentUser?.id === userId) {
        setCurrentUser(null)
      }
    } catch (error) {
      console.error('Failed to delete user:', error)
    }
  }

  const handleSelectSession = async (session: typeof sessions[0]) => {
    setCurrentSession(session)
    try {
      const { data } = await getMessages(session.id, 200)
      setMessages(data)
    } catch (error) {
      console.error('Failed to load messages:', error)
    }
  }

  const handleCreateSession = async () => {
    if (!currentUser) return
    try {
      const { data } = await createSession(currentUser.id)
      const { data: sessionsData } = await getSessions(currentUser.id)
      setSessions(sessionsData)
      handleSelectSession(data)
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this session?')) return
    try {
      await deleteSession(sessionId)
      if (currentUser) {
        const { data } = await getSessions(currentUser.id)
        setSessions(data)
      }
      if (currentSession?.id === sessionId) {
        setCurrentSession(null)
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    // Simple search implementation
    console.log('Search:', searchQuery)
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

  return (
    <div className="w-[280px] border-r bg-sidebar flex flex-col h-screen">
      {/* Search */}
      <div className="p-4 border-b bg-white/50">
        <div className="flex gap-2">
          <Input
            placeholder="搜索用户/会话 ID"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="text-sm"
          />
          <Button size="icon" variant="ghost" onClick={handleSearch} className="hover:bg-white flex-shrink-0">
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Users */}
      <div className="border-b bg-white/30">
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">用户</h3>
          <Dialog open={newUserDialog} onOpenChange={setNewUserDialog}>
            <DialogTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 hover:bg-primary hover:text-white transition-colors rounded-lg">
                <Plus className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>创建新用户</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div>
                  <label className="text-sm font-medium">外部 ID *</label>
                  <Input
                    value={newUserExtId}
                    onChange={(e) => setNewUserExtId(e.target.value)}
                    placeholder="user_001"
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">名称（可选）</label>
                  <Input
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="张三"
                    className="mt-1.5"
                  />
                </div>
                <Button onClick={handleCreateUser} className="w-full">
                  创建用户
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <ScrollArea className="h-[200px]">
          <div className="px-3 pb-3 space-y-1.5">
            {users.map((user) => (
              <div
                key={user.id}
                className={cn(
                  'group flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all',
                  'hover:bg-white hover:shadow-sm',
                  currentUser?.id === user.id && 'bg-white shadow-sm ring-1 ring-primary/30'
                )}
                onClick={() => handleSelectUser(user)}
              >
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center flex-shrink-0">
                  <UserIcon className="h-4 w-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {user.name || user.external_id}
                  </p>
                  <p className="text-xs text-muted-foreground truncate font-mono">
                    {user.id.slice(0, 8)}...
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyToClipboard(user.id, user.id)
                  }}
                >
                  {copiedId === user.id ? (
                    <Check className="h-3 w-3 text-success" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => handleDeleteUser(user.id, e)}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Sessions */}
      <div className="flex-1 flex flex-col min-h-0 bg-white/30">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold text-foreground">会话</h3>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 hover:bg-primary hover:text-white transition-colors rounded-lg"
            onClick={handleCreateSession}
            disabled={!currentUser}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-3 py-3 space-y-1.5">
            {!currentUser ? (
              <p className="text-xs text-muted-foreground text-center py-8">
                请先选择用户
              </p>
            ) : loading ? (
              <p className="text-xs text-muted-foreground text-center py-8">加载中...</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">
                暂无会话
              </p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    'group flex flex-col gap-1.5 p-2.5 rounded-lg cursor-pointer transition-all',
                    'hover:bg-white hover:shadow-sm',
                    currentSession?.id === session.id && 'bg-white shadow-sm ring-1 ring-primary/30'
                  )}
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-mono flex-1 truncate font-medium">{session.id.slice(0, 12)}...</p>
                    <Badge
                      variant={session.status === 'active' ? 'default' : 'secondary'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {session.status === 'active' ? '活跃' : '已归档'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{new Date(session.created_at).toLocaleDateString('zh-CN')}</span>
                    <span className="font-medium">{session.token_count} tokens</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
