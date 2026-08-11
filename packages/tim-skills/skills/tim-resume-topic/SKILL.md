---
name: tim-resume-topic
description: Recall what the project recorded about one topic — matching batch summaries in chronological order, the tasks/bugs/ideas on the same topic, and the newest such session's handoff note and raw turns. Use when the user says /tim-resume-topic, names a subject from earlier work ("the summarizer thing", "was hatten wir zu sync"), or asks what has already been done on a topic.
---

# TIM Resume Topic

Session start no longer injects the previous session. Past work is retrieved by
topic instead of by recency, and this is the retrieval.

## Steps

1. **Take the user's words as the topic.** `/tim-resume-topic tim-viewer` → topic
   is `tim-viewer`. No topic given → use the subject they just named. Do not
   translate it into a tag and do not go looking for one first: the tool searches
   tags and summary text together, which is the point. The viewer work is tagged
   `#tim-inspector`, and "tim-viewer" finds it anyway.
2. **Recall:** `tim_resume_topic({ topic })`. Add `limit` only when the output
   says it capped and you need the older sessions too.
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
- The header line says how many sessions were rendered of how many matched. When
  it capped, the topic started earlier than the oldest line shown — say so rather
  than reporting the first rendered session as the beginning.
- Nothing here mutates: `tim_resume_topic` starts no session and binds nothing.
  Exchanges keep appending to the current session.
- Zero hits means the words are wrong, not that the work never happened. Try what
  the feature was called at the time, or a plain `tim_search`, before telling the
  user there is nothing.
- For "what did we do last time", regardless of topic, use `/tim-continue`.
