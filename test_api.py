import httpx

BASE_URL = "http://localhost:19001"
MODEL = "Qwen3-Embedding-4B"


def get_models() -> str:
    resp = httpx.get(f"{BASE_URL}/v1/models", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    print("可用模型列表:")
    for m in data["data"]:
        print(f"  - {m['id']}")
    return data["data"][0]["id"]


def embed(model: str, texts: list[str]) -> dict:
    resp = httpx.post(
        f"{BASE_URL}/v1/embeddings",
        json={"model": model, "input": texts},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def test_single_text(model: str):
    print("\n===== 单条文本 embedding 测试 =====")
    texts = ["量子计算将如何改变密码学领域？"]
    result = embed(model, texts)

    emb = result["data"][0]["embedding"]
    print(f"输入: {texts[0]}")
    print(f"维度: {len(emb)}")
    print(f"前5维: {emb[:5]}")
    print(f"token 用量: {result['usage']}")


def test_batch_texts(model: str):
    print("\n===== 批量文本 embedding 测试 =====")
    texts = [
        "深度学习在自然语言处理中的应用",
        "Applications of deep learning in NLP",
        "今天天气真好，适合出去散步",
    ]
    result = embed(model, texts)

    print(f"输入数量: {len(texts)}")
    print(f"返回数量: {len(result['data'])}")
    for i, item in enumerate(result["data"]):
        emb = item["embedding"]
        print(f"  [{i}] 维度={len(emb)}, 前3维={emb[:3]}")
    print(f"token 用量: {result['usage']}")


def test_similarity(model: str):
    print("\n===== 语义相似度测试 =====")
    pairs = [
        ("我喜欢吃苹果", "我爱吃水果"),
        ("我喜欢吃苹果", "今天股市大涨"),
        ("machine learning", "机器学习"),
        ("machine learning", "烹饪技巧"),
    ]
    all_texts = []
    for a, b in pairs:
        all_texts.extend([a, b])

    result = embed(model, all_texts)
    embeddings = [item["embedding"] for item in result["data"]]

    for i, (a, b) in enumerate(pairs):
        vec_a = embeddings[i * 2]
        vec_b = embeddings[i * 2 + 1]
        sim = cosine_similarity(vec_a, vec_b)
        print(f"  「{a}」 vs 「{b}」 => 相似度: {sim:.4f}")


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


if __name__ == "__main__":
    get_models()
    test_single_text(MODEL)
    test_batch_texts(MODEL)
    test_similarity(MODEL)
    print("\n所有测试完成!")
