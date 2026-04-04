# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**replica** — Memory management solution for AI (用于AI的记忆管理方案).

## Repository

- **Remote:** https://github.com/echonoshy/replica.git
- **Branch:** master
- **Language:** Python

## Tooling

- **Dependency management:** uv (`uv sync`, `uv add <pkg>`, `uv run <cmd>`)
- **Formatting:** `ruff format`
- **Linting:** `ruff check` (use `ruff check --fix` for auto-fix)
- **Testing:** `pytest` (run via `uv run pytest`)
- **Line length:** 120 (configured in `pyproject.toml` via `[tool.ruff]`)

## Configuration

- All configuration files are stored in the `config/` directory
- Use YAML format (`.yaml`) for configuration files
- Do not use `.env` to save the config

## Database (Development)

- **Engine:** PostgreSQL 17 + pgvector (Docker)
- **Connection:** `postgresql+asyncpg://postgres:password@localhost:5432/replica`
- **Docker setup:**
  ```bash
  docker run -d --name pgvector -e POSTGRES_PASSWORD=password -p 5432:5432 pgvector/pgvector:pg17
  docker exec -it pgvector psql -U postgres -c "CREATE DATABASE replica;"
  docker exec -it pgvector psql -U postgres -d replica -c "CREATE EXTENSION IF NOT EXISTS vector;"
  ```

## Coding Conventions

- **不要生成 `__init__.py`：** 除非模块确实需要包级别的导入/导出，否则不要创建 `__init__.py` 文件。
- **使用 `pyrootutils`：** 通过 `pyrootutils` 管理项目根路径和模块导入。
- **代码完成后必须运行 `ruff check`：** 每次修改代码后执行 `ruff check` 和 `ruff format` 确保代码质量。
- **行宽限制 120：** Ruff 的 `line-length` 已配置为 120，所有代码应遵循此限制。
- **优先使用内置类型注解：** 使用 `list[str]`、`dict[str, str]` 等，不要从 `typing` 导入 `List`、`Dict`、`Optional` 等。
- **不要使用 `from __future__ import annotations`。**
- **路径操作使用 `pathlib`：** 不要使用 `os.path` 或字符串拼接。
- **不要使用环境变量语法：** 不使用 `os.getenv` 或 `os.environ`。
- **测试用例使用 `if __name__ == "__main__":` 模式。**

## Frontend (Tailwind CSS v4)

项目使用 **Tailwind CSS v4**（2025年1月发布），采用 CSS-first 配置方式。

### 核心语法变化

**导入方式：**
```css
/* ❌ 旧语法 (v3) - 不要使用 */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ✅ 新语法 (v4) - 使用这个 */
@import "tailwindcss";
```

**主题自定义（使用 @theme 指令）：**
```css
@import "tailwindcss";

@theme {
  /* 自定义颜色 */
  --color-primary: #3b82f6;
  --color-secondary: #10b981;
  --color-accent: #f59e0b;
  
  /* 自定义间距 */
  --spacing-custom: 2.5rem;
  
  /* 自定义字体 */
  --font-display: "Inter", sans-serif;
}
```

### 配置规范

- **不使用 `tailwind.config.js`：** v4 采用 CSS-first 配置，所有自定义直接写在 CSS 文件中
- **使用 `@theme` 定义变量：** 颜色、间距、字体等通过 CSS 变量定义
- **零配置起点：** 默认配置已足够，仅在需要时添加自定义
- **性能优化：** v4 使用 Rust 引擎，构建速度提升 3.5-100 倍

### 参考资料

- [Tailwind CSS v4 Complete Guide](https://www.noqta.tn/en/tutorials/tailwind-css-v4-complete-guide-2026)
- [Migration Best Practices](https://www.digitalapplied.com/blog/tailwind-css-v4-2026-migration-best-practices)
- [What Changed & How to Upgrade](https://designrevision.com/blog/tailwind-4-migration)
