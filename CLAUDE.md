# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供代码库工作指南。

## 项目概述

**replica** — 用于 AI 的记忆管理方案。

## 仓库信息

- **远程仓库:** https://github.com/echonoshy/replica.git
- **分支:** master
- **语言:** Python (后端), TypeScript/React (前端)

## 工具链

### Python

- **依赖管理:** uv (`uv sync`, `uv add <pkg>`, `uv run <cmd>`)
- **代码格式化:** `ruff format`
- **代码检查:** `ruff check` (使用 `ruff check --fix` 自动修复)
- **测试:** pytest (通过 `uv run pytest` 运行)
- **行宽限制:** 120 (在 `pyproject.toml` 中通过 `[tool.ruff]` 配置)

### 前端 (TypeScript/React)

- **构建工具:** Vite
- **包管理器:** bun (`bun install`, `bun add <pkg>`, `bun run <cmd>`)
- **代码检查:** ESLint (`bun run lint`, 使用 `bun run lint:fix` 自动修复)
- **代码格式化:** Prettier (`bun run format`, 使用 `bun run format:check` 仅检查)
- **类型检查:** TypeScript 严格模式 (`strict: true`)
- **框架:** React 19 + Vite 8 + Tailwind CSS v4

## 配置

- 所有配置文件存储在 `config/` 目录
- 配置文件使用 YAML 格式 (`.yaml`)
- 不要使用 `.env` 保存配置

## 数据库 (开发环境)

- **引擎:** PostgreSQL 17 + pgvector (Docker)
- **连接:** `postgresql+asyncpg://postgres:password@localhost:5432/replica`
- **Docker 启动:**
  ```bash
  docker run -d --name pgvector -e POSTGRES_PASSWORD=password -p 5432:5432 pgvector/pgvector:pg17
  docker exec -it pgvector psql -U postgres -c "CREATE DATABASE replica;"
  docker exec -it pgvector psql -U postgres -d replica -c "CREATE EXTENSION IF NOT EXISTS vector;"
  ```

## 编码规范

### Python (后端)

- **不要生成 `__init__.py`：** 除非模块确实需要包级别的导入/导出，否则不要创建 `__init__.py` 文件
- **使用 `pyrootutils`：** 通过 `pyrootutils` 管理项目根路径和模块导入
- **代码完成后必须运行质量检查：** 每次修改 Python 代码后执行以下命令：
  ```bash
  ruff format .        # 格式化代码
  ruff check .         # 检查代码质量
  ruff check --fix .   # 自动修复问题（可选）
  ```
- **行宽限制 120：** Ruff 的 `line-length` 已配置为 120，所有代码应遵循此限制
- **优先使用内置类型注解：** 使用 `list[str]`、`dict[str, str]` 等，不要从 `typing` 导入 `List`、`Dict`、`Optional` 等
- **不要使用 `from __future__ import annotations`**
- **路径操作使用 `pathlib`：** 不要使用 `os.path` 或字符串拼接
- **不要使用环境变量语法：** 不使用 `os.getenv` 或 `os.environ`

### TypeScript/React (前端)

- **代码完成后必须运行质量检查：** 每次修改前端代码后执行以下命令：
  ```bash
  cd web
  bun run lint         # 检查 ESLint 错误
  bun run lint:fix     # 自动修复 ESLint 错误
  bun run format       # 使用 Prettier 格式化代码
  bun run format:check # 检查格式（不修改文件）
  ```
- **TypeScript 严格模式：** 项目已启用 `strict: true`，必须遵守严格类型检查
- **禁止未使用的变量：** `tsconfig.json` 中已启用 `noUnusedLocals` 和 `noUnusedParameters`，及时清理未使用的导入和变量
- **禁止使用 `any` 类型：** ESLint 已配置 `@typescript-eslint/no-explicit-any` 规则，必须明确指定类型
- **路径别名：** 使用 `@/*` 映射到 `./src/*`

## 前端 (Tailwind CSS v4)

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
  --color-primary: #3b82f6;
  --color-secondary: #10b981;
  --color-accent: #f59e0b;
  --spacing-custom: 2.5rem;
  --font-display: "Inter", sans-serif;
}
```

### 配置规范

- **不使用 `tailwind.config.js`：** v4 采用 CSS-first 配置，所有自定义直接写在 CSS 文件中
- **使用 `@theme` 定义变量：** 颜色、间距、字体等通过 CSS 变量定义
- **零配置起点：** 默认配置已足够，仅在需要时添加自定义
