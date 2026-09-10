# Session summary coverage

A batch summary does not imply that its entire exchange batch is covered. A session can continue after a partial summary, leaving newer exchanges in the same batch pending.

TIM compares observed user exchange sequence numbers with the summary's recorded inclusive `seq_from` and `seq_to` bounds. Exchanges outside that interval remain pending. The idle sweep and unsummarized-session view use this coverage rule instead of subtracting `batch count × batch size` from the exchange count.

## Legacy and malformed ranges

A summary with missing, nonnumeric or reversed bounds does not establish coverage. Its text remains available, but the associated observed exchanges remain pending until a valid summary range is recorded. TIM does not infer that an old summary covers the full batch merely because it exists.

This is a conservative compatibility policy: it can request another summarization pass for legacy data, but it avoids silently declaring newer or unproven exchanges covered. Imported ranges are compared against observed exchanges; TIM does not expand arbitrarily large numeric intervals into memory.

The idle sweep has a separate retry guard: by default it stops after three unsuccessful summarizer spawns for a session. A pending range is not proof that a summarizer is available or that the source conversation was fully captured. Inspect diagnostics and the configured worker chain before retrying; do not fabricate bounds to make a health indicator green.

## Limits of the evidence

Sequence coverage records which observed exchanges a summary claims to cover. It does not establish that the summary is accurate, complete or useful. Raw exchanges remain the reference for inspection and re-summarization. Missing host capture cannot be reconstructed from summary counters.
