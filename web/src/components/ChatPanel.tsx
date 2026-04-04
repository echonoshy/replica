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
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
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
  const streamingTextRef = useRef('')
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
      // Use requestAnimationFrame to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        if (chatContainerRef.current) {
          chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
        }
      })
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
    streamingTextRef.current = ''
    const ctrl = new AbortController()
    abortCtrlRef.current = ctrl

    await chatStream(
      currentSession.id,
      content,
      useMemory,
      {
        onToken: (token) => {
          setStreamingText((prev) => prev + token)
          streamingTextRef.current += token
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
            content: streamingTextRef.current,
            token_count: 0,
            message_type: 'message',
            is_compacted: false,
            created_at: new Date().toISOString(),
          }
          addMessage(aiMsg)
          setStreamingText('')
          streamingTextRef.current = ''
          setSending(false)
          abortCtrlRef.current = null
          if (tokenCount !== undefined) {
            updateSessionTokenCount(tokenCount)
          }
        },
        onError: (err) => {
          setStreamingText((prev) => prev + `\n[错误: ${err}]`)
          streamingTextRef.current += `\n[错误: ${err}]`
          setSending(false)
          abortCtrlRef.current = null
        },
      },
      ctrl.signal
    )
  }

  const handleStop = () => {
    abortCtrlRef.current?.abort()
    if (streamingTextRef.current) {
      const stoppedMsg: Message = {
        id: 'temp-stopped-' + Date.now(),
        session_id: currentSession!.id,
        parent_id: null,
        role: 'assistant',
        content: streamingTextRef.current + '\n[已中止]',
        token_count: 0,
        message_type: 'message',
        is_compacted: false,
        created_at: new Date().toISOString(),
      }
      addMessage(stoppedMsg)
      setStreamingText('')
      streamingTextRef.current = ''
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!hasSession) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-6 text-foreground px-8 bg-background">
        <div className="w-32 h-32 rounded-md border-4 border-border bg-secondary flex items-center justify-center shadow-[12px_12px_0px_0px_#111111] hover:scale-105 transition-transform cursor-pointer">
          <Bot className="h-16 w-16 text-foreground animate-pulse" />
        </div>
        <h2 className="text-4xl font-black uppercase tracking-tighter text-foreground bg-accent px-6 py-2 border-4 border-border shadow-[6px_6px_0px_0px_#111111] -rotate-2">
          {currentUser ? '开始新对话' : '欢迎使用 Replica'}
        </h2>
        <p className="text-lg text-center max-w-md font-bold bg-white p-4 border-2 border-border shadow-[4px_4px_0px_0px_#111111]">
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
      <div className="px-6 py-3 border-b-4 border-border bg-accent">
        <div className="flex items-center gap-3">
          <TokenProgress current={currentSession.token_count} />
          <Button
            variant="default"
            size="sm"
            onClick={copySessionId}
            className="flex items-center gap-1.5 text-xs bg-white text-foreground border-2 border-border shadow-[2px_2px_0px_0px_#111111] hover:bg-muted hover:shadow-[4px_4px_0px_0px_#111111] px-3 py-1.5"
          >
            <span className="font-mono font-bold text-[11px]">{currentSession.id.slice(0, 12)}...</span>
            {copiedSessionId ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3 text-foreground" />
            )}
          </Button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1" viewportRef={chatContainerRef}>
        <div className="max-w-4xl mx-auto px-6 py-6">
          {messages.length === 0 && !streamingText && (
            <div className="flex flex-col items-center justify-center h-full gap-6 text-foreground py-24">
              <div className="w-24 h-24 rounded-md border-4 border-border bg-accent flex items-center justify-center shadow-[8px_8px_0px_0px_#111111] rotate-[-5deg] hover:rotate-0 transition-transform cursor-pointer">
                <Bot className="h-12 w-12 text-foreground" />
              </div>
              <p className="text-xl font-bold uppercase tracking-widest bg-primary text-white px-4 py-2 border-2 border-border shadow-[4px_4px_0px_0px_#111111]">输入消息开始对话</p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'flex gap-4 py-8 transition-colors group',
                msg.role === 'assistant' && 'bg-ai-bg border-y-2 border-border -mx-6 px-6 shadow-[0px_4px_0px_0px_#111111] mb-4'
              )}
            >
              <div
                className={cn(
                  'w-10 h-10 rounded-md border-2 border-border flex items-center justify-center flex-shrink-0 shadow-[2px_2px_0px_0px_#111111]',
                  msg.role === 'user' && 'bg-primary text-white',
                  msg.role === 'assistant' && 'bg-secondary text-secondary-foreground',
                  msg.role === 'system' && 'bg-muted text-muted-foreground'
                )}
              >
                {msg.role === 'assistant' ? (
                  <Bot className="h-6 w-6" />
                ) : msg.role === 'user' ? (
                  <UserIcon className="h-6 w-6" />
                ) : (
                  <span className="text-sm font-bold">SYS</span>
                )}
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-bold uppercase tracking-wider text-foreground">
                    {msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'AI 助手' : '系统'}
                  </span>
                  {msg.message_type !== 'message' && (
                    <Badge
                      variant={msg.message_type === 'compaction_summary' ? 'destructive' : 'secondary'}
                      className="text-[10px] px-2 py-0.5"
                    >
                      {msg.message_type}
                    </Badge>
                  )}
                </div>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-[16px] whitespace-pre-wrap leading-relaxed font-medium">{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {/* Streaming message */}
          {streamingText && (
            <div className="flex gap-4 py-8 px-6 border-y-2 border-border bg-accent/20 mb-4 shadow-[0px_4px_0px_0px_#111111] -mx-6">
              <div className="w-10 h-10 rounded-md border-2 border-border flex items-center justify-center flex-shrink-0 bg-secondary text-secondary-foreground shadow-[2px_2px_0px_0px_#111111] animate-bounce">
                <Bot className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-bold uppercase tracking-wider text-foreground">AI 助手</span>
                  <Badge variant="secondary" className="text-[10px] shadow-[2px_2px_0px_0px_#111111]">
                    生成中...
                  </Badge>
                </div>
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {streamingText}
                  </ReactMarkdown>
                  <span className="inline-block w-3 h-5 bg-primary animate-pulse ml-1 rounded-sm align-middle"></span>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 border-t-4 border-border bg-secondary">
        <div className="flex gap-2">
          <Button
            variant={useMemory ? 'default' : 'outline'}
            size="sm"
            onClick={() => setUseMemory(!useMemory)}
            className={cn("text-xs font-black uppercase tracking-wider", useMemory ? "bg-primary" : "bg-white text-foreground")}
          >
            {useMemory ? <ToggleRight className="h-4 w-4 mr-1" /> : <ToggleLeft className="h-4 w-4 mr-1" />}
            记忆 {useMemory ? 'ON' : 'OFF'}
          </Button>
        </div>
        <div className="flex gap-2">
          {sessionActive && (
            <Button
              variant="default"
              size="sm"
              onClick={handleMemorize}
              disabled={memorizing || messages.length === 0}
              className="text-xs font-black uppercase tracking-wider bg-accent text-foreground hover:bg-accent/90"
            >
              {memorizing ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              提取记忆
            </Button>
          )}
        </div>
      </div>

      {/* Memorize result toast */}
      {memorizeResult && (
        <div className="px-6 py-3 text-sm font-bold uppercase tracking-wider text-center bg-success text-black border-t-4 border-border shadow-[inset_0px_4px_0px_0px_rgba(0,0,0,0.1)]">
          {memorizeResult}
        </div>
      )}

      {/* Input area */}
      <div className="flex gap-3 p-4 border-t-2 border-border bg-white/80 backdrop-blur-sm">
        <textarea
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息，按 Enter 发送，Shift + Enter 换行..."
          disabled={!sessionActive}
          className="flex-1 resize-none min-h-[48px] max-h-[200px] px-4 py-3 bg-input border-2 border-border rounded-md text-[15px] font-medium leading-relaxed focus:outline-none focus:ring-0 disabled:opacity-50 transition-all placeholder:text-muted-foreground/60 shadow-[4px_4px_0px_0px_#111111]"
          rows={1}
        />
        {sending ? (
          <Button size="icon" onClick={handleStop} variant="destructive" className="h-12 w-12 shrink-0">
            <Square className="h-5 w-5" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!sessionActive || !msgInput.trim()}
            className="h-12 w-12 shrink-0"
          >
            <Send className="h-5 w-5" />
          </Button>
        )}
      </div>
    </div>
  )
}
