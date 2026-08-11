export const TIM_RESUME_TOPIC_SKILL = {
  name: "tim-resume-topic",
  description: "Recall everything the project recorded about one topic — batch summaries across all sessions in chronological order, the tasks/bugs/ideas sharing the tag, and the newest such session's handoff note and raw turns. Use when the user says /tim-resume-topic, names a subject from earlier work (\"the summarizer thing\", \"was hatten wir zu sync\"), or asks what has already been done on a topic.",
  content: `# TIM Resume Topic

Session start no longer injects the previous session. Past work is retrieved by
topic instead of by recency, and this is the retrieval.

## Steps

1. **Pick the tag.** The user's words are usually not the tag. If you are unsure
   which tag a topic lives under, call \`tim_search\` with a \`tag\` argument and no
   \`query\` to probe a guess, or \`tim_search\` with a query to find entries first
   and read their tags. Prefer a tag the project already uses over a new coinage.
2. **Recall:** Call \`tim_resume_topic\` with that tag (with or without the \`#\`).
3. **Read it as context, not as output.** The response is chronological: what
   was done on this topic, in order, then the open tasks/bugs/ideas, then the
   newest session's handoff note and the turns no summary covers yet.
   - Do NOT paraphrase the whole thing back to the user.
   - Confirm in one or two lines: where the topic stands and what is open.
4. **Continue the work** from that state.

## Rules

- If the output says the newest session ended without a handoff note, say so.
  Do not substitute an older session's note, and do not present a summary as if
  it were a handoff — a missing note means nobody wrote down what to do next.
- Nothing here mutates: \`tim_resume_topic\` starts no session and binds nothing.
  Exchanges keep appending to the current session.
- Zero hits means the tag is wrong, not that the work never happened. Try a
  neighbouring tag or a full-text \`tim_search\` before telling the user there is
  nothing.
- For "what did we do last time", regardless of topic, use \`/tim-continue\`.
`,
};
