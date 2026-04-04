"""Compaction prompts for semantic message summarization."""

SEGMENT_SUMMARIZATION_PROMPT = """You are a conversation summarizer. Your task is to extract and preserve the core information from a conversation segment.

【Conversation Segment】
{conversation_text}

【Task】
Summarize this conversation segment while preserving:
1. Key facts, decisions, and conclusions
2. Important context and background information
3. User preferences and requirements mentioned
4. Technical details and specific data points
5. Action items and next steps

【Requirements】
- Keep the summary concise (aim for 20-30% of original length)
- Maintain chronological order and causal relationships
- Use clear, natural language
- Remove redundant greetings, confirmations, and repetitive content
- Preserve specific names, numbers, and technical terms
- If the conversation contains code or commands, keep the essential parts

【Output Format】
Output the summary directly as plain text, no JSON or special formatting needed.

Summary:"""


SEGMENT_SUMMARIZATION_PROMPT_ZH = """你是一个对话总结助手。你的任务是从一段对话中提取并保留核心信息。

【对话片段】
{conversation_text}

【任务】
总结这段对话，同时保留：
1. 关键事实、决策和结论
2. 重要的上下文和背景信息
3. 提到的用户偏好和需求
4. 技术细节和具体数据点
5. 行动项和后续步骤

【要求】
- 保持总结简洁（目标是原文的 20-30% 长度）
- 保持时间顺序和因果关系
- 使用清晰、自然的语言
- 去除冗余的寒暄、确认和重复内容
- 保留具体的名称、数字和技术术语
- 如果对话包含代码或命令，保留关键部分

【输出格式】
直接输出总结文本，不需要 JSON 或特殊格式。

总结："""
