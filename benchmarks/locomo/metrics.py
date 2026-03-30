"""LoCoMo evaluation metrics — token-level F1 with normalization and stemming.

Ported from https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py
"""

import string
import unicodedata
from collections import Counter

import regex
from nltk.stem import PorterStemmer

_stemmer = PorterStemmer()


class SimpleTokenizer:
    ALPHA_NUM = r"[\p{L}\p{N}\p{M}]+"
    NON_WS = r"[^\p{Z}\p{C}]"

    def __init__(self):
        self._regexp = regex.compile(
            "(%s)|(%s)" % (self.ALPHA_NUM, self.NON_WS),
            flags=regex.IGNORECASE + regex.UNICODE + regex.MULTILINE,
        )

    def tokenize(self, text: str, uncased: bool = False) -> list[str]:
        matches = [m for m in self._regexp.finditer(text)]
        if uncased:
            return [m.group().lower() for m in matches]
        return [m.group() for m in matches]


def normalize_answer(s: str) -> str:
    s = s.replace(",", "")
    s = unicodedata.normalize("NFD", s)
    s = s.lower()
    exclude = set(string.punctuation)
    s = "".join(ch for ch in s if ch not in exclude)
    s = regex.sub(r"\b(a|an|the|and)\b", " ", s)
    return " ".join(s.split())


def f1_score(prediction: str, ground_truth: str) -> float:
    pred_tokens = [_stemmer.stem(w) for w in normalize_answer(prediction).split()]
    gt_tokens = [_stemmer.stem(w) for w in normalize_answer(ground_truth).split()]
    common = Counter(pred_tokens) & Counter(gt_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0.0
    precision = num_same / len(pred_tokens)
    recall = num_same / len(gt_tokens)
    return (2 * precision * recall) / (precision + recall)


def f1_multi_answer(prediction: str, ground_truth: str) -> float:
    """For multi-hop (category 1): split by comma, compute partial F1 per sub-answer."""
    predictions = [p.strip() for p in prediction.split(",")]
    ground_truths = [g.strip() for g in ground_truth.split(",")]
    scores = []
    for gt in ground_truths:
        best = max(f1_score(pred, gt) for pred in predictions)
        scores.append(best)
    return sum(scores) / len(scores) if scores else 0.0


def evaluate_single_qa(prediction: str, answer: str, category: int) -> float:
    """Evaluate a single QA pair according to its LoCoMo category.

    Categories:
        1 - Multi-hop: split answers, partial F1
        2 - Temporal: standard F1
        3 - Open-domain: take first answer before ';'
        4 - Single-hop: standard F1
        5 - Adversarial: check if model correctly says "no information"
    """
    if category == 5:
        lower_pred = prediction.lower()
        if "no information available" in lower_pred or "not mentioned" in lower_pred:
            return 1.0
        return 0.0

    if category == 3:
        answer = answer.split(";")[0].strip()

    if category == 1:
        return f1_multi_answer(prediction, answer)

    return f1_score(prediction, answer)


def aggregate_scores(results: list[dict]) -> dict:
    """Aggregate per-QA scores into category-level and overall statistics."""
    category_names = {
        1: "multi_hop",
        2: "temporal",
        3: "open_domain",
        4: "single_hop",
        5: "adversarial",
    }

    by_category: dict[int, list[float]] = {}
    all_scores = []

    for r in results:
        cat = r["category"]
        score = r["f1"]
        by_category.setdefault(cat, []).append(score)
        all_scores.append(score)

    summary = {}
    for cat in sorted(by_category):
        scores = by_category[cat]
        name = category_names.get(cat, f"cat_{cat}")
        summary[name] = {
            "count": len(scores),
            "accuracy": round(sum(scores) / len(scores), 4) if scores else 0.0,
        }

    summary["overall"] = {
        "count": len(all_scores),
        "accuracy": round(sum(all_scores) / len(all_scores), 4) if all_scores else 0.0,
    }
    return summary
