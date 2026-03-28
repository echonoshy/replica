import math

import httpx

BASE_URL = "http://localhost:19002"
MODEL = "Qwen3-Reranker-4B"

RERANKER_SYSTEM_PROMPT = (
    "Judge whether the Document is relevant to the Query. Answer only 'yes' or 'no'."
)

TEST_PAIRS = [
    {
        "query": "什么是机器学习？",
        "document": "机器学习是人工智能的一个分支，它使计算机系统能够从数据中学习和改进，而无需显式编程。",
        "expected_relevant": True,
    },
    {
        "query": "什么是机器学习？",
        "document": "今天北京天气晴朗，最高气温32度，适合户外活动。",
        "expected_relevant": False,
    },
]


def test_health():
    print("=" * 60)
    print("[1] 健康检查 GET /health")
    print("=" * 60)
    resp = httpx.get(f"{BASE_URL}/health")
    print(f"  状态码: {resp.status_code}")
    print(f"  响应: {resp.text}")
    assert resp.status_code == 200, f"健康检查失败: {resp.status_code}"
    print("  ✅ 通过\n")


def test_models():
    print("=" * 60)
    print("[2] 模型列表 GET /v1/models")
    print("=" * 60)
    resp = httpx.get(f"{BASE_URL}/v1/models")
    print(f"  状态码: {resp.status_code}")
    data = resp.json()
    models = [m["id"] for m in data["data"]]
    print(f"  可用模型: {models}")
    assert resp.status_code == 200, f"获取模型列表失败: {resp.status_code}"
    assert len(models) > 0, "没有可用模型"
    print("  ✅ 通过\n")


def compute_reranker_score(logprobs: dict) -> float:
    """从 logprobs 中提取 yes/no 概率并计算相关性分数。"""
    yes_logprob = logprobs.get("yes", -100)
    no_logprob = logprobs.get("no", -100)
    yes_prob = math.exp(yes_logprob)
    no_prob = math.exp(no_logprob)
    score = yes_prob / (yes_prob + no_prob)
    return score


def test_reranker(query: str, document: str, expected_relevant: bool, index: int):
    print("=" * 60)
    print(f"[3.{index}] Reranker 测试")
    print(f"  Query:    {query}")
    print(f"  Document: {document[:60]}...")
    print(f"  预期相关: {'是' if expected_relevant else '否'}")
    print("=" * 60)

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": RERANKER_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"<Query>{query}</Query>\n<Document>{document}</Document>",
            },
        ],
        "logprobs": True,
        "top_logprobs": 5,
        "max_tokens": 1,
        "temperature": 0.0,
        "chat_template_kwargs": {"enable_thinking": False},
    }

    resp = httpx.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=60)
    print(f"  状态码: {resp.status_code}")
    assert resp.status_code == 200, f"请求失败: {resp.status_code} {resp.text}"

    data = resp.json()
    choice = data["choices"][0]
    answer = choice["message"]["content"].strip()
    print(f"  模型回答: {answer}")

    token_logprobs = choice.get("logprobs", {}).get("content", [])
    if token_logprobs:
        first_token = token_logprobs[0]
        top_lp = {
            item["token"]: item["logprob"]
            for item in first_token.get("top_logprobs", [])
        }
        print(f"  Top logprobs: {top_lp}")
        score = compute_reranker_score(top_lp)
        print(f"  相关性分数: {score:.4f}")
    else:
        print("  ⚠️  未返回 logprobs")

    print(f"  Usage: {data.get('usage', {})}")

    is_relevant = answer.lower().startswith("yes")
    if is_relevant == expected_relevant:
        print("  ✅ 结果符合预期\n")
    else:
        print("  ⚠️  结果与预期不符（不影响接口可用性判断）\n")


if __name__ == "__main__":
    print("\n🚀 Qwen3-Reranker-4B API 接口测试\n")

    test_health()
    test_models()

    for i, pair in enumerate(TEST_PAIRS, 1):
        test_reranker(pair["query"], pair["document"], pair["expected_relevant"], i)

    print("=" * 60)
    print("✅ 所有接口测试完成")
    print("=" * 60)
