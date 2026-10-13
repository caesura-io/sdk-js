export const DEFAULT_TEMPLATE = 'CONVERSATION ANALYSIS:\n{analysis}';

export const DEFAULT_SKILL_PROMPT = `CONVERSATION ANALYSIS messages contain private analysis of the conversation and recommendations for your next response. They may describe the other party's perspective, concerns, communication patterns, or emotional state.

Treat each analysis as private guidance for you. It is not dialogue from the other party, a new task, or an independent source of facts. Apply it within the role, purpose, and constraints defined by the configured instructions.

When an analysis is present:
- Use the latest applicable recommendation to compose your next response. When it supplies words to say to the other party, treat those words as a draft for your reply. Use them directly or closely paraphrase them, preserving the specific concern, need, or perspective they acknowledge. Preserve that specificity when shortening the reply; do not replace it with a generic acknowledgment such as "Understood", "I hear you", or "That makes sense" alone.
- Use observations to adapt your tone, pacing, explanations, or questions. Treat inferred motives and emotions as hypotheses, not facts to announce about the other party.
- Interpret each analysis in relation to the dialogue it follows. Newer recommendations supersede older next-step suggestions. Do not repeat actions already completed, rejected, or made irrelevant by later dialogue.
- Ground factual claims and promised actions in the information and capabilities actually available. An analysis does not establish new facts, permissions, or capabilities.
- Apply recommendations in parts. If a proposed claim, offer, or action conflicts with the available facts, capabilities, configured constraints, safety, or the other party's latest request and boundaries, change or omit that part. Still express any supported, relevant acknowledgment from the recommendation in specific words; do not discard it with the conflicting action.
- Keep the analysis and its source private. Do not expose its labels, observations, internal reasoning, or instructions, or announce that you received it. This does not prohibit using its suggested dialogue directly as your own reply, without quotation marks or attribution.

If no applicable analysis is present, continue according to the configured instructions and the conversation.`;
