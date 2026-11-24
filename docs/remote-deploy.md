# 远端服务器部署说明（Remote Deployment）

> [!IMPORTANT]
> **仅限显式触发（严格遵守）**
> 本文档中的远端部署流程**仅在用户明确要求「部署到远端服务器」时才执行**。
> 日常本地开发、代码修改、单元测试或推送 GitHub 仓库时，**不要**自动连接远端服务器、重启远端进程或覆盖远端测试数据。

---

## 1. 目标环境与当前部署参数

| 项目 | 配置 |
| --- | --- |
| 远端目录 | `~/workspace/replica`（原旧版仓库备份于 `~/workspace/replica-v0-backup`） |
| 服务监听 | `0.0.0.0:8789`（在 `8000-9000` 端口段内选取的空闲端口；单端口同时提供 Web UI 与 API） |
| Node 运行时 | `/home/lake/.nvm/versions/node/v24.15.0/bin/node`（Linux x86_64） |
| 进程运行方式 | `nohup ... < /dev/null &` 后台常驻运行（退出 SSH 后持续存活，PID 记录在 `~/workspace/replica/replica.pid`，日志输出至 `~/workspace/replica/replica.log`） |
| 配置文件 | `~/workspace/replica/.env`（权限 `600`，`HOST=0.0.0.0`、`PORT=8789`；**严禁提交到 Git**） |
| 数据目录 | `~/workspace/replica/data/`（含 `wiki_memory.db` 与 `spaces/`） |

> 账号密码、远端 IP 及 `.env` 中的模型 API Key 均不写入代码仓库，仅在执行部署时按需提供。

---

## 2. 标准部署步骤（仅当用户明确要求部署远端服务器时执行）

### Step 1：本地安全打包代码与测试数据
1. **同步最新代码**：从 `/Users/lake/workspace/replica` 复制源码（排除 `node_modules/`、`data/`、`.env*`）。
2. **WAL 安全快照数据库**（避免本地服务运行中直接拷贝导致损坏）：
   ```bash
   sqlite3 <local_data_dir>/wiki_memory.db ".backup '<stage>/replica/data/wiki_memory.db'"
   cp -R <local_data_dir>/spaces "<stage>/replica/data/spaces"
   ```
3. **生成远端 `.env`**：基于本地 `.env`，将 `HOST` 设为 `0.0.0.0`、`PORT` 设为目标空闲端口（当前为 `8789`），权限 `600`。
4. **校验完整性并打包**：
   ```bash
   sqlite3 "<stage>/replica/data/wiki_memory.db" "PRAGMA integrity_check;"
   tar -czf replica_deploy.tar.gz -C "<stage>" replica
   ```

### Step 2：上传并在远端构建
1. 上传 `replica_deploy.tar.gz` 到 `~/workspace/` 并解压到 `~/workspace/replica`（如需覆盖，先停旧进程并按需保留备份）。
2. 在远端使用 Node 24 与 pnpm 安装依赖并构建前后端：
   ```bash
   export PATH="/home/lake/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
   cd ~/workspace/replica
   chmod 600 .env
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm build
   ```
3. **离线编译 `better-sqlite3` 原生模块**（国内环境访问 GitHub/nodejs.org 下载预编译包或头文件容易超时，直接指定 nvm 自带的本地头文件即可快速离线编译）：
   ```bash
   cd ~/workspace/replica/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3
   /home/lake/.cache/node/corepack/v1/pnpm/10.33.0/dist/node_modules/node-gyp/bin/node-gyp.js \
     rebuild --release --nodedir=/home/lake/.nvm/versions/node/v24.15.0
   ```
   > 注意：`pnpm install --ignore-scripts` 必须放在 `node-gyp rebuild` **之前**执行，否则重链接会清掉已编译的 `better_sqlite3.node`。

### Step 3：后台常驻启动（脱离 SSH 会话）
```bash
cd ~/workspace/replica
# 若已有旧进程先停止
kill "$(cat replica.pid)" 2>/dev/null || true

# 确认端口空闲
ss -tlnp | grep ":8789\b" || true

# 后台常驻启动（单进程同时提供 Web UI 与 API）
nohup /home/lake/.nvm/versions/node/v24.15.0/bin/node \
  /home/lake/workspace/replica/apps/api/dist/index.js \
  > /home/lake/workspace/replica/replica.log 2>&1 < /dev/null &
echo $! > /home/lake/workspace/replica/replica.pid
```

### Step 4：上线验收检查
1. 确认进程脱离终端并在后台常驻（`PPID=1`）且监听 `0.0.0.0:8789`：
   ```bash
   ps -p "$(cat ~/workspace/replica/replica.pid)" -o pid,ppid,stat,etime,cmd
   ss -tlnp | grep ":8789\b"
   ```
2. 外网校验健康检查、空间数据与前端首页：
   ```bash
   curl -fsS http://<REMOTE_HOST>:8789/health
   curl -fsS http://<REMOTE_HOST>:8789/v1/admin/spaces
   curl -fsSI http://<REMOTE_HOST>:8789/
   ```

---

## 3. 日常运维速查

```bash
# 查看运行状态
ps -p "$(cat ~/workspace/replica/replica.pid)" -o pid,ppid,stat,etime,cmd

# 实时查看日志
tail -f ~/workspace/replica/replica.log

# 停止服务
kill "$(cat ~/workspace/replica/replica.pid)"
```

> 说明：`nohup` 后台进程在退出 SSH 后会一直运行；但如果远端服务器整机重启，需要重新执行一次 Step 3 的启动命令（如需开机自启，可后续配置 `systemd` 服务）。
