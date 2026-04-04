import { useState, useEffect } from 'react'
import SessionSidebar from '@/components/SessionSidebar'
import ChatPanel from '@/components/ChatPanel'
import MemoryPanel from '@/components/MemoryPanel'
import { cn } from '@/lib/utils'

export default function ChatView() {
  const [memoryWidth, setMemoryWidth] = useState(360)
  const [isDragging, setIsDragging] = useState(false)

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const startX = e.clientX
    const startWidth = memoryWidth

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      setMemoryWidth(Math.max(240, Math.min(800, startWidth + delta)))
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  useEffect(() => {
    return () => {
      setIsDragging(false)
    }
  }, [])

  return (
    <div className={cn('flex h-screen w-full', isDragging && 'cursor-col-resize select-none')}>
      <SessionSidebar />
      <ChatPanel />

      {/* Resize handle */}
      <div
        className={cn(
          'w-1.5 cursor-col-resize flex items-center justify-center flex-shrink-0 relative z-10 transition-colors hover:bg-primary/20',
          isDragging && 'bg-primary/20'
        )}
        onMouseDown={handleMouseDown}
      >
        <div
          className={cn(
            'w-0.5 h-8 rounded-full bg-border transition-all',
            'hover:bg-primary hover:h-12',
            isDragging && 'bg-primary h-12'
          )}
        />
      </div>

      <MemoryPanel style={{ width: `${memoryWidth}px`, minWidth: `${memoryWidth}px` }} />
    </div>
  )
}
