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
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1">
        <Progress
          value={percentage}
          className="h-2"
          indicatorClassName={cn(getProgressColor())}
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">
          {current.toLocaleString()} / {hardThreshold.toLocaleString()}
        </span>
        <span
          className={cn(
            'px-2 py-0.5 rounded text-[10px] font-medium',
            status === 'hard' && 'bg-destructive/10 text-destructive',
            status === 'soft' && 'bg-warning/10 text-warning',
            status === 'normal' && 'bg-success/10 text-success'
          )}
        >
          {getStatusText()}
        </span>
      </div>
    </div>
  )
}
