import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app";
import JsonViewer from "./JsonViewer";

export default function ApiMonitor() {
  const { apiLogs, clearApiLogs } = useAppStore();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedIds(newSet);
  };

  const getMethodColor = (method: string) => {
    switch (method.toUpperCase()) {
      case "GET":
        return "bg-info/10 text-info";
      case "POST":
        return "bg-success/10 text-success";
      case "DELETE":
        return "bg-destructive/10 text-destructive";
      case "PUT":
      case "PATCH":
        return "bg-warning/10 text-warning";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getStatusColor = (status?: number) => {
    if (!status) return "text-muted-foreground";
    if (status >= 200 && status < 300) return "text-success";
    if (status >= 400 && status < 500) return "text-warning";
    if (status >= 500) return "text-destructive";
    return "text-muted-foreground";
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">API Monitor</h3>
        <Button variant="ghost" size="sm" onClick={clearApiLogs} disabled={apiLogs.length === 0}>
          <Trash2 className="h-3 w-3 mr-1" />
          Clear
        </Button>
      </div>

      <ScrollArea className="h-[400px]">
        <div className="space-y-2">
          {apiLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No API requests yet</p>
          ) : (
            apiLogs.map((log) => {
              const isExpanded = expandedIds.has(log.id);
              return (
                <div key={log.id} className="border rounded-lg p-3 hover:bg-muted/50 transition-colors">
                  <div className="flex items-center gap-2 cursor-pointer" onClick={() => toggleExpand(log.id)}>
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    )}
                    <Badge variant="secondary" className={cn("text-[10px] font-medium", getMethodColor(log.method))}>
                      {log.method}
                    </Badge>
                    <span className="text-xs font-mono flex-1 truncate">{log.url}</span>
                    {log.status && (
                      <span className={cn("text-xs font-medium", getStatusColor(log.status))}>{log.status}</span>
                    )}
                    {log.duration !== undefined && (
                      <span className="text-xs text-muted-foreground">{log.duration}ms</span>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="mt-3 space-y-2 pl-5">
                      {log.error && (
                        <div>
                          <p className="text-xs font-medium text-destructive mb-1">Error:</p>
                          <p className="text-xs text-destructive/80">{log.error}</p>
                        </div>
                      )}
                      {log.requestBody && (
                        <div>
                          <p className="text-xs font-medium mb-1">Request:</p>
                          <JsonViewer data={log.requestBody} maxHeight={200} />
                        </div>
                      )}
                      {log.responseBody && (
                        <div>
                          <p className="text-xs font-medium mb-1">Response:</p>
                          <JsonViewer data={log.responseBody} maxHeight={200} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
