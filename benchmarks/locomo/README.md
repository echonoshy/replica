## 文件结构

```text
benchmarks/locomo/
├── data/
│   └── locomo10.json           # LoCoMo 数据集（10 个对话，1986 个 QA）
├── results/
│   ├── v1/                     # 版本 v1 的测试结果
│   │   ├── metadata.json       # 版本元信息（git commit、描述、时间）
│   │   ├── user_mapping.json   # sample_id → user_id 映射
│   │   └── results_top50.json
│   └── v2/                     # 版本 v2 ...
├── metrics.py                  # 评测指标（token-level F1、归一化、词干化）
├── ingest.py                   # 将 LoCoMo 对话导入 Replica
├── evaluate.py                 # 检索 + LLM 回答 + 计算 F1 分数
├── compare.py                  # 多版本结果对比工具
└── run_benchmark.sh            # 一键运行脚本
```

## 使用方式

### 前置条件

- Replica 服务已启动（例如：`uvicorn replica.main:app --port 8790`）
- LLM / Embedding 服务可用（按 `config/settings.yaml` 配置）

### 方式一：一键运行（推荐）

```bash
# 必须指定 --version
bash benchmarks/locomo/run_benchmark.sh --version v2

# 附带描述信息
bash benchmarks/locomo/run_benchmark.sh --version v2 --description "改进了 episode 提取逻辑"

# 只跑评测（跳过 ingest，复用已有数据）
bash benchmarks/locomo/run_benchmark.sh --version v2 --skip-ingest

# 指定 top_k 值（默认 50）
bash benchmarks/locomo/run_benchmark.sh --version v2 --top-k 50
```

该脚本会自动完成：

1. 导入数据（版本隔离，不同版本的用户数据互不干扰）
2. 以指定的 `top_k`（默认 50）运行评测
3. 分别以 `episode/event/foresight` 三种类型运行评测
4. 结果保存到 `results/<version>/`，自动记录 git commit 和元信息

### 方式二：分步运行

#### Step 1：导入数据

```bash
python benchmarks/locomo/ingest.py \
    --base-url http://localhost:8790/v1 \
    --version v2
```

#### Step 2：运行评测

```bash
python benchmarks/locomo/evaluate.py \
    --base-url http://localhost:8790/v1 \
    --version v2 \
    --top-k 50
```

#### 可选参数

- `--entry-type episode|event|foresight`：只使用某一类记忆做检索
- `--sample-ids conv-26 conv-27`：只评测特定对话
- `--top-k 50`：调整检索数量（默认 10）
- `--description "描述这次测试"`：添加版本描述

### 对比多版本结果

```bash

python benchmarks/locomo/compare.py v1 v2

# 对比所有版本
python benchmarks/locomo/compare.py --all

# 只看 top50 结果
python benchmarks/locomo/compare.py --all --pattern top50
```

输出示例：

```text
  Version Metadata
================================================================================
        v1  commit=abc1234  time=2026-03-28T10:00  desc=基线版本
        v2  commit=def5678  time=2026-03-31T14:00  desc=改进 episode 提取

================================================================================
  results_top50
================================================================================
Category          v1            v2
----------------------------------------------
single_hop        0.4940        0.5200
multi_hop         0.3109        0.3500
...
overall           0.5231        0.5550

  Delta vs v1:
Category          v2
----------------------------------------------
single_hop       +0.0260
multi_hop        +0.0391
...
overall          +0.0319
```

## 多版本测试工作流

当你不停迭代功能时，推荐的工作流：

1. **修改代码** → 重启 Replica 服务
2. **运行 benchmark** → `bash benchmarks/locomo/run_benchmark.sh --version v3 --description "改了xxx"`
3. **对比结果** → `python benchmarks/locomo/compare.py v1 v2 v3`

每个版本的用户数据通过 `external_id` 前缀隔离（`locomo_<version>_<sample_id>`），因此：
- 不同版本可以在同一个数据库中共存
- 不需要在版本之间清库
- 如果只改了检索/评测逻辑（没改 memorize），可以用 `--skip-ingest` 复用之前版本的 ingest 数据

## 输出示例

结果会按 LoCoMo 的 5 个类别分别统计 F1 准确率：

| 类别         | 说明     | 数量 | F1 |
|--------------|----------|------|----|
| single_hop   | 单跳检索 | 596  | -  |
| multi_hop    | 多跳推理 | 398  | -  |
| temporal     | 时间推理 | 398  | -  |
| open_domain  | 开放问题 | 196  | -  |
| adversarial  | 对抗性   | 398  | -  |
| overall      | 总计     | 1986 | -  |
