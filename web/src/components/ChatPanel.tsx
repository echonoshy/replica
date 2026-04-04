import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import TokenProgress from './TokenProgress'
import { chatStream } from '@/api/chat'
import { memorizeSession } from '@/api/sessions'
import { getEvergreenMemories } from '@/api/memory'
import { Send, Square, Bot, User as UserIcon, Sparkles, ToggleLeft, ToggleRight, Loader2, Copy, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import type { Message } from '@/types'

export default function ChatPanel() {
  const {
    currentUser,
    currentSession,
    messages,
    addMessage,
    updateSessionTokenCount,
    setChatContext,
  } = useAppStore()

  const [msgInput, setMsgInput] = useState('')
  const [sending, setSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [useMemory, setUseMemory] = useState(true)
  const [memorizing, setMemorizing] = useState(false)
  const [memorizeResult, setMemorizeResult] = useState<string | null>(null)
  const [copiedSessionId, setCopiedSessionId] = useState(false)

  const abortCtrlRef = useRef<AbortController | null>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  const hasSession = currentSession !== null
  const sessionActive = currentSession?.status === 'active'

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText])

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
    }
  }

  const handleSend = async () => {
    if (!currentSession || !msgInput.trim() || sending) return

    const content = msgInput.trim()
    setMsgInput('')
    setSending(true)

    // Add user message
    const userMsg: Message = {
      id: 'temp-user-' + Date.now(),
      session_id: currentSession.id,
      parent_id: null,
      role: 'user',
      content,
      token_count: 0,
      message_type: 'message',
      is_compacted: false,
      created_at: new Date().toISOString(),
    }
    addMessage(userMsg)

    setStreamingText('')
    const ctrl = new AbortController()
    abortCtrlRef.current = ctrl

    await chatStream(
      currentSession.id,
      content,
      useMemory,
      {
        onToken: (token) => {
          setStreamingText((prev) => prev + token)
        },
        onContext: (ctx) => {
          setChatContext(ctx)
        },
        onDone: async (messageId, tokenCount) => {
          const aiMsg: Message = {
            id: messageId || 'temp-ai-' + Date.now(),
            session_id: currentSession.id,
            parent_id: null,
            role: 'assistant',
            content: streamingText,
            token_count: 0,
            message_type: 'message',
            is_compacted: false,
            created_at: new Date().toISOString(),
          }
          addMessage(aiMsg)
          setStreamingText('')
          setSending(false)
          abortCtrlRef.current = null
          if (tokenCount !== undefined) {
            updateSessionTokenCount(tokenCount)
          }
        },
        onError: (err) => {
          setStreamingText((prev) => prev + `\n[错误: ${err}]`)
          setSending(false)
          abortCtrlRef.current = null
        },
      },
      ctrl.signal
    )
  }

  const handleStop = () => {
    abortCtrlRef.current?.abort()
    if (streamingText) {
      const stoppedMsg: Message = {
        id: 'temp-stopped-' + Date.now(),
        session_id: currentSession!.id,
        parent_id: null,
        role: 'assistant',
        content: streamingText + '\n[已中止]',
        token_count: 0,
        message_type: 'message',
        is_compacted: false,
        created_at: new Date().toISOString(),
      }
      addMessage(stoppedMsg)
      setStreamingText('')
    }
    setSending(false)
    abortCtrlRef.current = null
  }

  const handleMemorize = async () => {
    if (!currentSession || memorizing) return
    setMemorizing(true)
    setMemorizeResult(null)
    try {
      const { data } = await memorizeSession(currentSession.id)
      setMemorizeResult(`提取完成，生成 ${data.memory_count} 条知识`)
      if (currentUser) {
        const { data: eg } = await getEvergreenMemories(currentUser.id)
        useAppStore.getState().setEvergreen(eg)
      }
    } catch (e: any) {
      setMemorizeResult(`提取失败: ${e.response?.data?.detail ?? e.message}`)
    } finally {
      setMemorizing(false)
      setTimeout(() => setMemorizeResult(null), 5000)
    }
  }

  const copySessionId = async () => {
    if (!currentSession) return
    try {
      await navigator.clipboard.writeText(currentSession.id)
      setCopiedSessionId(true)
      setTimeout(() => setCopiedSessionId(false), 1500)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!hasSession) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground px-8">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/10 flex items-center justify-center">
          <Bot className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">
          {currentUser ? '开始新对话' : '欢迎使用 Replica'}
        </h2>
        <p className="text-sm text-center max-w-md">
          {currentUser
            ? '在左侧选择已有会话，或点击 + 创建新会话开始对话'
            : '请先在左侧选择用户，或创建新用户开始使用'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-screen bg-background">
      {/* Token bar */}
      <div className="px-6 py-3.5 border-b bg-white/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <TokenProgress current={currentSession.token_count} />
          <Button
            variant="ghost"
            size="sm"
            onClick={copySessionId}
            className="flex items-center gap-1.5 text-xs hover:bg-muted rounded-lg px-2.5 py-1.5"
          >
            <span className="font-mono text-muted-foreground text-[11px]">{currentSession.id.slice(0, 12)}...</span>
            {copiedSessionId ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </Button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1" ref={chatContainerRef}>
        <div className="max-w-4xl mx-auto px-6 py-6">
          {messages.length === 0 && !streamingText && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground py-24">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 flex items-center justify-center">
                <Bot className="h-7 w-7 text-primary" />
              </div>
              <p className="text-sm">输入消息开始对话</p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'flex gap-4 py-8 transition-colors group',
                msg.role === 'assistant' && 'bg-ai-bg/50 -mx-6 px-6'
              )}
            >
              <div
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                  msg.role === 'user' && 'bg-gradient-to-br from-primary to-primary/80 text-white',
                  msg.role === 'assistant' && 'bg-gradient-to-br from-accent to-accent/80 text-white',
                  msg.role === 'system' && 'bg-muted text-muted-foreground'
                )}
              >
                {msg.role === 'assistant' ? (
                  <Bot className="h-4 w-4" />
                ) : msg.role === 'user' ? (
                  <UserIcon className="h-4 w-4" />
                ) : (
                  <span className="text-xs font-semibold">S</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-foreground">
                    {msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'AI 助手' : '系统'}
                  </span>
                  {msg.message_type !== 'message' && (
                    <Badge
                      variant={msg.message_type === 'compaction_summary' ? 'destructive' : 'secondary'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {msg.message_type}
                    </Badge>
                  )}
                </div>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-[15px] whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {/* Streaming message */}
          {streamingText && (
            <div className="flex gap-3 py-6 px-4 border-t bg-muted/30">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-sm animate-pulse">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold">AI</span>
                  <Badge variant="secondary" className="text-[10px] shadow-sm">
                    生成中...
                  </Badge>
                </div>
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {streamingText}
                  </ReactMarkdown>
                  <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 rounded-sm">▍</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-2 border-t">
        <div className="flex gap-2">
          <Button
            variant={useMemory ? 'default' : 'outline'}
            size="sm"
            onClick={() => setUseMemory(!useMemory)}
            className="text-xs"
          >
            {useMemory ? <ToggleRight className="h-3 w-3 mr-1" /> : <ToggleLeft className="h-3 w-3 mr-1" />}
            记忆 {useMemory ? 'ON' : 'OFF'}
          </Button>
        </div>
        <div className="flex gap-2">
          {sessionActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleMemorize}
              disabled={memorizing || messages.length === 0}
              className="text-xs"
            >
              {memorizing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 mr-1" />
              )}
              提取记忆
            </Button>
          )}
        </div>
      </div>

      {/* Memorize result toast */}
      {memorizeResult && (
        <div className="px-6 py-2 text-xs text-center bg-success/10 text-success border-t">
          {memorizeResult}
        </div>
      )}

      {/* Input area */}
      <div className="flex gap-3 p-4 border-t bg-white/80 backdrop-blur-sm">
        <textarea
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息，按 Enter 发送，Shift + Enter 换行..."
          disabled={!sessionActive}
          className="flex-1 resize-none min-h-[48px] max-h-[200px] px-4 py-3 bg-input border border-border rounded-xl text-[15px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent disabled:opacity-50 transition-all placeholder:text-muted-foreground/60"
          rows={1}
        />
        {sending ? (
          <Button size="icon" onClick={handleStop} variant="destructive" className="h-12 w-12 rounded-xl shadow-sm hover:shadow-md transition-all">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!sessionActive || !msgInput.trim()}
            className="h-12 w-12 rounded-xl shadow-sm hover:shadow-md transition-all"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
