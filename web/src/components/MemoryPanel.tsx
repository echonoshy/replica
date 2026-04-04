import { useState } from 'react'
import { useAppStore } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronDown, ChevronRight, Plus, Trash2, RefreshCw, Search } from 'lucide-react'
import { createEvergreenMemory, deleteEvergreenMemory, getEvergreenMemories } from '@/api/memory'
import { searchKnowledge } from '@/api/memory'
import { cn } from '@/lib/utils'
import type { EvergreenCategory, EntryType, KnowledgeSearchResult } from '@/types'

export default function MemoryPanel({ style }: { style?: React.CSSProperties }) {
  const { currentUser, currentSession, evergreen, chatContext, setEvergreen } = useAppStore()

  const [expandedSections, setExpandedSections] = useState({
    evergreen: true,
    session: true,
    knowledge: true,
  })

  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryCategory, setNewMemoryCategory] = useState<EvergreenCategory>('fact')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchType, setSearchType] = useState<EntryType | 'all'>('all')
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const handleAddEvergreen = async () => {
    if (!currentUser || !newMemoryContent.trim()) return
    try {
      await createEvergreenMemory(currentUser.id, {
        category: newMemoryCategory,
        content: newMemoryContent.trim(),
      })
      const { data } = await getEvergreenMemories(currentUser.id)
      setEvergreen(data)
      setNewMemoryContent('')
    } catch (error) {
      console.error('Failed to add evergreen memory:', error)
    }
  }

  const handleDeleteEvergreen = async (id: string) => {
    if (!currentUser) return
    try {
      await deleteEvergreenMemory(id)
      const { data } = await getEvergreenMemories(currentUser.id)
      setEvergreen(data)
    } catch (error) {
      console.error('Failed to delete evergreen memory:', error)
    }
  }

  const handleRefreshEvergreen = async () => {
    if (!currentUser) return
    try {
      const { data } = await getEvergreenMemories(currentUser.id)
      setEvergreen(data)
    } catch (error) {
      console.error('Failed to refresh evergreen:', error)
    }
  }

  const handleSearch = async () => {
    if (!currentUser || !searchQuery.trim()) return
    setSearching(true)
    try {
      const { data } = await searchKnowledge({
        user_id: currentUser.id,
        query: searchQuery.trim(),
        entry_type: searchType === 'all' ? undefined : searchType,
        top_k: 10,
      })
      setSearchResults(data)
    } catch (error) {
      console.error('Failed to search knowledge:', error)
    } finally {
      setSearching(false)
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'episode':
        return 'bg-info/10 text-info'
      case 'event':
        return 'bg-success/10 text-success'
      case 'foresight':
        return 'bg-warning/10 text-warning'
      default:
        return 'bg-muted text-muted-foreground'
    }
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'fact':
        return 'bg-info/10 text-info'
      case 'preference':
        return 'bg-success/10 text-success'
      case 'relationship':
        return 'bg-warning/10 text-warning'
      case 'goal':
        return 'bg-primary/10 text-primary'
      default:
        return 'bg-muted text-muted-foreground'
    }
  }

  const injectedEvergreenIds = new Set(chatContext?.evergreen.map((e) => e.id) || [])
  const injectedKnowledgeIds = new Set(chatContext?.knowledge.map((k) => k.id) || [])

  return (
    <div className="flex flex-col h-screen bg-card border-l" style={style}>
      <div className="p-4 border-b">
        <h2 className="text-sm font-semibold">Memory System</h2>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Layer 1: Evergreen */}
          <Card className="p-3">
            <div
              className="flex items-center justify-between cursor-pointer mb-2"
              onClick={() => toggleSection('evergreen')}
            >
              <div className="flex items-center gap-2">
                {expandedSections.evergreen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <h3 className="text-sm font-semibold">Layer 1: Evergreen</h3>
                <Badge variant="secondary" className="text-[10px]">
                  {evergreen.length}
                </Badge>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation()
                  handleRefreshEvergreen()
                }}
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>

            {expandedSections.evergreen && (
              <div className="space-y-2">
                {currentUser && (
                  <div className="space-y-2">
                    <Select
                      value={newMemoryCategory}
                      onValueChange={(v) => setNewMemoryCategory(v as EvergreenCategory)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fact">Fact</SelectItem>
                        <SelectItem value="preference">Preference</SelectItem>
                        <SelectItem value="relationship">Relationship</SelectItem>
                        <SelectItem value="goal">Goal</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Add new memory..."
                        value={newMemoryContent}
                        onChange={(e) => setNewMemoryContent(e.target.value)}
                        className="text-xs"
                      />
                      <Button size="icon" className="h-8 w-8" onClick={handleAddEvergreen}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}

                <ScrollArea className="max-h-[300px]">
                  <div className="space-y-2">
                    {evergreen.map((mem) => (
                      <div
                        key={mem.id}
                        className={cn(
                          'group p-2 rounded border text-xs',
                          injectedEvergreenIds.has(mem.id) && 'border-l-4 border-l-primary bg-primary/5'
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <Badge
                              variant="secondary"
                              className={cn('text-[10px] mb-1', getCategoryColor(mem.category))}
                            >
                              {mem.category}
                            </Badge>
                            <p className="text-xs">{mem.content}</p>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 opacity-0 group-hover:opacity-100"
                            onClick={() => handleDeleteEvergreen(mem.id)}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
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
          <Card className="p-3">
            <div
              className="flex items-center gap-2 cursor-pointer mb-2"
              onClick={() => toggleSection('session')}
            >
              {expandedSections.session ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <h3 className="text-sm font-semibold">Layer 2: Session Context</h3>
            </div>

            {expandedSections.session && currentSession && (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Token Count:</span>
                  <span className="font-mono">{currentSession.token_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Compactions:</span>
                  <span className="font-mono">{currentSession.compaction_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status:</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {currentSession.status}
                  </Badge>
                </div>
              </div>
            )}
          </Card>

          {/* Layer 3: Knowledge */}
          <Card className="p-3">
            <div
              className="flex items-center gap-2 cursor-pointer mb-2"
              onClick={() => toggleSection('knowledge')}
            >
              {expandedSections.knowledge ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <h3 className="text-sm font-semibold">Layer 3: Knowledge</h3>
            </div>

            {expandedSections.knowledge && (
              <div className="space-y-3">
                {/* Current context */}
                {chatContext && chatContext.knowledge.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-2">本轮检索结果:</p>
                    <ScrollArea className="max-h-[300px]">
                      <div className="space-y-2">
                        {chatContext.knowledge.map((k) => (
                          <div
                            key={k.id}
                            className="p-2 rounded border border-l-4 border-l-info bg-info/5 text-xs"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <Badge
                                variant="secondary"
                                className={cn('text-[10px]', getTypeColor(k.entry_type))}
                              >
                                {k.entry_type}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {(k.score * 100).toFixed(1)}%
                              </span>
                            </div>
                            {k.title && <p className="font-medium mb-1">{k.title}</p>}
                            <p className="text-muted-foreground line-clamp-3">{k.content}</p>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {/* Manual search */}
                {currentUser && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">手动搜索:</p>
                    <Select
                      value={searchType}
                      onValueChange={(v) => setSearchType(v as EntryType | 'all')}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="episode">Episode</SelectItem>
                        <SelectItem value="event">Event</SelectItem>
                        <SelectItem value="foresight">Foresight</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Search knowledge..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        className="text-xs"
                      />
                      <Button
                        size="icon"
                        className="h-8 w-8"
                        onClick={handleSearch}
                        disabled={searching}
                      >
                        <Search className="h-3 w-3" />
                      </Button>
                    </div>

                    {searchResults.length > 0 && (
                      <ScrollArea className="max-h-[300px]">
                        <div className="space-y-2">
                          {searchResults.map((result) => (
                            <div key={result.id} className="p-2 rounded border text-xs">
                              <div className="flex items-center justify-between mb-1">
                                <Badge
                                  variant="secondary"
                                  className={cn('text-[10px]', getTypeColor(result.entry_type))}
                                >
                                  {result.entry_type}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {(result.score * 100).toFixed(1)}%
                                </span>
                              </div>
                              {result.title && <p className="font-medium mb-1">{result.title}</p>}
                              <p className="text-muted-foreground line-clamp-3">{result.content}</p>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </ScrollArea>
    </div>
  )
}
