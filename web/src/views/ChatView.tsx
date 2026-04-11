import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import SessionSidebar from "@/components/SessionSidebar";
import ChatPanel from "@/components/ChatPanel";
import MemoryPanel from "@/components/MemoryPanel";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ChatView() {
  const navigate = useNavigate();
  const [memoryWidth, setMemoryWidth] = useState(480);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = memoryWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setMemoryWidth(Math.max(240, Math.min(800, startWidth + delta)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  useEffect(() => {
    return () => {
      setIsDragging(false);
    };
  }, []);

  return (
    <div className={cn("flex h-screen w-full relative", isDragging && "cursor-col-resize select-none")}>
      <SessionSidebar />
      <ChatPanel />

      {/* Resize handle */}
      <div
        className={cn(
          "w-1.5 cursor-col-resize flex items-center justify-center flex-shrink-0 relative z-10 transition-colors bg-border hover:bg-primary",
          isDragging && "bg-primary",
        )}
        onMouseDown={handleMouseDown}
      >
        <div className={cn("w-0.5 h-12 bg-white transition-all", "hover:h-16", isDragging && "h-16")} />
      </div>

      <MemoryPanel style={{ width: `${memoryWidth}px`, minWidth: `${memoryWidth}px` }} />

      {/* Admin button - fixed at bottom left */}
      <Button
        variant="default"
        size="default"
        onClick={() => navigate("/admin")}
        className="fixed bottom-6 left-6 z-50 shadow-[4px_4px_0px_0px_#111111] hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[6px_6px_0px_0px_#111111] transition-all bg-white text-foreground border-2 border-border font-black uppercase tracking-wider"
      >
        <Settings className="h-5 w-5 mr-2" />
        管理面板
      </Button>
    </div>
  );
}
