interface JsonViewerProps {
  data: unknown
  maxHeight?: number
}

export default function JsonViewer({ data, maxHeight = 400 }: JsonViewerProps) {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2)

  return (
    <pre
      className="bg-muted p-4 rounded-lg overflow-auto text-xs font-mono"
      style={{ maxHeight: `${maxHeight}px` }}
    >
      {jsonString}
    </pre>
  )
}
