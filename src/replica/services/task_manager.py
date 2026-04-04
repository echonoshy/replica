"""Task status manager for async operations.

Tracks background task status (compaction, extraction, etc.) in memory.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class TaskStatus(str, Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class TaskInfo:
    def __init__(self, task_id: str, task_type: str, session_id: str | None = None):
        self.task_id = task_id
        self.task_type = task_type
        self.session_id = session_id
        self.status = TaskStatus.pending
        self.created_at = datetime.now(timezone.utc)
        self.started_at: datetime | None = None
        self.completed_at: datetime | None = None
        self.result: dict[str, Any] | None = None
        self.error: str | None = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "session_id": self.session_id,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "result": self.result,
            "error": self.error,
        }


class TaskManager:
    """In-memory task status tracker."""

    def __init__(self):
        self._tasks: dict[str, TaskInfo] = {}
        self._lock = asyncio.Lock()

    async def create_task(self, task_type: str, session_id: str | None = None) -> str:
        """Create a new task and return task_id."""
        task_id = str(uuid.uuid4())
        async with self._lock:
            self._tasks[task_id] = TaskInfo(task_id, task_type, session_id)
        return task_id

    async def get_task(self, task_id: str) -> TaskInfo | None:
        """Get task info by ID."""
        async with self._lock:
            return self._tasks.get(task_id)

    async def update_status(
        self,
        task_id: str,
        status: TaskStatus,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ):
        """Update task status."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return

            task.status = status
            if status == TaskStatus.processing and not task.started_at:
                task.started_at = datetime.now(timezone.utc)
            elif status in (TaskStatus.completed, TaskStatus.failed):
                task.completed_at = datetime.now(timezone.utc)

            if result:
                task.result = result
            if error:
                task.error = error

    async def cleanup_old_tasks(self, max_age_seconds: int = 3600):
        """Remove tasks older than max_age_seconds."""
        now = datetime.now(timezone.utc)
        async with self._lock:
            to_remove = [
                task_id
                for task_id, task in self._tasks.items()
                if (now - task.created_at).total_seconds() > max_age_seconds
            ]
            for task_id in to_remove:
                del self._tasks[task_id]


# Global singleton
task_manager = TaskManager()
