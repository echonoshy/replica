## 文件结构

```text
benchmarks/locomo/
├── data/
│   └── locomo10.json           # LoCoMo 数据集（10 个对话，1986 个 QA）
├── metrics.py                  # 评测指标（token-level F1、归一化、词干化）
├── ingest.py                   # 将 LoCoMo 对话导入 Replica
├── evaluate.py                 # 检索 + LLM 回答 + 计算 F1 分数
└── run_benchmark.sh            # 一键运行脚本
```

## 使用方式

### 前置条件

- Replica 服务已启动（例如：`uvicorn replica.main:app --port 8790`）
- LLM / Embedding / Rerank 服务可用（按 `config/settings.yaml` 配置）

### 方式一：一键运行

```bash
bash benchmarks/locomo/run_benchmark.sh
```

该脚本会自动完成：

1. 导入数据
2. 分别以 `top_k=5/10/25` 运行评测
3. 分别以 `episode/event/foresight` 三种类型运行评测

### 方式二：分步运行

#### Step 1：导入数据（每个 session 写入消息后会自动 memorize）

```bash
python benchmarks/locomo/ingest.py \
    --base-url http://localhost:8790/v1
```

#### Step 2：运行评测

```bash
python benchmarks/locomo/evaluate.py \
    --base-url http://localhost:8790/v1 \
    --top-k 10 \
    --output benchmarks/locomo/data/results.json
```

#### 可选参数

- `--entry-type episode|event|foresight`：只使用某一类记忆做检索
- `--sample-ids conv-26 conv-27`：只评测特定对话
- `--top-k 5`：调整检索数量

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



#### test1

| 类别                | top_k=5  | top_k=10 | top_k=25 |
|---------------------|----------|----------|----------|
| single_hop (841)    | 0.4526   | 0.4940   | 0.5198   |
| multi_hop (282)     | 0.2604   | 0.3109   | 0.3694   |
| temporal (321)      | 0.3656   | 0.3794   | 0.4018   |
| open_domain (96)    | 0.0868   | 0.1144   | 0.1362   |
| adversarial (446)   | 0.9081   | 0.9036   | 0.9036   |
| overall (1986)      | 0.4958   | 0.5231   | 0.5470   |