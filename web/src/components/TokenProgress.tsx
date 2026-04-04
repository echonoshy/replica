import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface TokenProgressProps {
  current: number
  softThreshold?: number
  hardThreshold?: number
}

export default function TokenProgress({
  current,
  softThreshold = 12000,
  hardThreshold = 16000,
}: TokenProgressProps) {
  const percentage = Math.min((current / hardThreshold) * 100, 100)

  const getStatus = () => {
    if (current >= hardThreshold) return 'hard'
    if (current >= softThreshold) return 'soft'
    return 'normal'
  }

  const status = getStatus()

  const getStatusText = () => {
    if (status === 'hard') return 'Hard Compaction'
    if (status === 'soft') return 'Soft Compaction'
    return 'Normal'
  }

  const getProgressColor = () => {
    if (status === 'hard') return 'bg-destructive'
    if (status === 'soft') return 'bg-warning'
    return 'bg-success'
  }

  return (
    <div className="flex items-center gap-3 py-3 w-full">
      <div className="flex-1 border-2 border-border shadow-[2px_2px_0px_0px_#111111] rounded-md overflow-hidden bg-white">
        <Progress
          value={percentage}
          className="h-3 rounded-none"
          indicatorClassName={cn(getProgressColor())}
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono font-bold text-foreground bg-white px-2 py-0.5 border-2 border-border shadow-[2px_2px_0px_0px_#111111]">
          {current.toLocaleString()} / {hardThreshold.toLocaleString()}
        </span>
        <span
          className={cn(
            'px-2 py-0.5 border-2 border-border shadow-[2px_2px_0px_0px_#111111] text-[10px] font-black uppercase tracking-wider',
            status === 'hard' && 'bg-destructive text-white',
            status === 'soft' && 'bg-warning text-black',
            status === 'normal' && 'bg-success text-black'
          )}
        >
          {getStatusText()}
        </span>
      </div>
    </div>
  )
}
