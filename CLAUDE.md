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

## Configuration

- All configuration files are stored in the `config/` directory
- Use YAML format (`.yaml`) for configuration files
- Do not use `.env` to save the config