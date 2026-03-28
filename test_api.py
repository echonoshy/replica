import sys
import time

from openai import OpenAI

BASE_URL = "http://localhost:19000/v1"
API_KEY = "EMPTY"
MODEL = "qwen3.5-122b"

ENABLE_THINKING = False


def _build_params(enable_thinking: bool) -> tuple[dict, dict]:
    extra_body: dict = {"top_k": 20}
    if enable_thinking:
        params = {"temperature": 1.0, "top_p": 0.95, "presence_penalty": 1.5}
    else:
        params = {"temperature": 0.7, "top_p": 0.8, "presence_penalty": 1.5}
        extra_body["chat_template_kwargs"] = {"enable_thinking": False}
    return params, extra_body


def _typewriter(text: str, delay: float = 0.02) -> None:
    for ch in text:
        sys.stdout.write(ch)
        sys.stdout.flush()
        time.sleep(delay)


def chat(prompt: str, *, enable_thinking: bool = ENABLE_THINKING) -> None:
    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    params, extra_body = _build_params(enable_thinking)

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=8096,
        extra_body=extra_body,
        **params,
    )

    choice = response.choices[0]
    reasoning = getattr(choice.message, "reasoning_content", None)
    if reasoning:
        print(f"\033[2m[思考过程]\n{reasoning}\033[0m\n")
    print(f"[回复]\n{choice.message.content}")


def chat_stream(prompt: str, *, enable_thinking: bool = ENABLE_THINKING) -> None:
    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    params, extra_body = _build_params(enable_thinking)

    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=8096,
        extra_body=extra_body,
        stream=True,
        **params,
    )

    thinking_started = False
    content_started = False

    for chunk in stream:
        delta = chunk.choices[0].delta
        if hasattr(delta, "reasoning_content") and delta.reasoning_content:
            if not thinking_started:
                print("\033[2m[思考过程]")
                thinking_started = True
            sys.stdout.write(delta.reasoning_content)
            sys.stdout.flush()
        if delta.content:
            if not content_started:
                if thinking_started:
                    print("\033[0m")
                print("[回复]")
                content_started = True
            _typewriter(delta.content)

    print("\033[0m")


if __name__ == "__main__":
    prompt = "请用简洁的语言解释什么是混合专家模型（MoE）？"

    print("=" * 60)
    print("流式调用（思考模式）" if ENABLE_THINKING else "流式调用（直答模式）")
    print("=" * 60)
    chat_stream(prompt)
