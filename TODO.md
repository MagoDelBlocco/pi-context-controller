# context-controller — Future Heuristics

All items below are pure algorithmic, no LLM calls.

---

## ~~Cross-Tool Correlation~~ ✅ DONE

Merge adjacent `tool_call` → `tool_result` pairs into single transcript lines when
the result is within 1–2 blocks and shares the same tool `name`.

**Before:**
```
* bash "npm test" (#12)
[tool_error] bash (#13)
FAIL tests/auth.test.ts
```

**After:**
```
* bash "npm test" → FAIL tests/auth.test.ts (#12-#13)
```

**Implementation:** single pass over brief transcript sections. When emitting a
`tool_call` line, peek ahead 1–2 blocks in the filtered array. If next block is
`tool_result` with matching `name`, append outcome inline. For chains
(call → result → call → result), repeat. Collapses debugging loops of 4+ blocks
into 2 lines.

**Where:** `compaction.cpp`, brief transcript emission loop.

**Config param:** `correlationDepth` (default: 2).

---

## Error Pattern Clustering

Normalize error messages by stripping variable data (file paths, line numbers,
hex addresses, quoted values, bare digits), then deduplicate by exact string
match on the normalized form.

**Normalization pipeline (regex, hardcoded patterns):**
- File paths: `src/auth.ts:42:` → `<FILE>`
- Line refs: `line 42`, `at line 58` → `line <N>`
- Hex values: `0x7f3a2b...` → `<HEX>`
- Quoted strings: `'undefined'`, `"null"` → `<VAL>`
- Bare digit runs: `\b\d+\b` → `<N>`

**Before:**
```
- [bash] src/auth.ts:42: error TS2345: Argument of type 'string'...
- [bash] src/server.ts:58: error TS2345: Argument of type 'string'...
```

**After:**
```
- [bash] error TS2345: Argument of type 'string' is not assignable... (occurred 2x)
```

**Where:** `compaction.cpp`, outstanding context collection phase. Add
`normalizeError()` to `helpers.h`/`helpers.cpp`.

---

## ~~File Dependency Inference~~ ✅ DONE

Track which files were **read** in a recent sliding window before each **write**.
If file A was read then file B was written, infer B depends on A.

**Mechanism:**
- `std::deque<std::string> recentReads` (max 10 entries)
- On `read` tool call: push path onto deque
- On `write`/`edit` tool call: record all deque entries as dependencies of the
  written file, then clear deque
- Output: append `(deps: file1, file2)` to modified/created file entries

**Before:**
```
[Files And Changes]
- Modified: src/server.ts
- Created: src/auth.ts
```

**After:**
```
[Files And Changes]
- Modified: src/server.ts (deps: src/auth.ts, src/middleware/rateLimiter.ts)
- Created: src/auth.ts
```

**Caveat:** false positives when a file is read for reference rather than
dependency. Bounded by the sliding window size.

**Where:** `compaction.cpp`, file extraction phase. New config param
`dependencyWindow` (default: 10).

---

## Temporal Decay for Transcript Capping

Replace oldest-first line dropping with weighted decay. When `briefMaxLines` is
exceeded, drop lowest-weighted lines first instead of oldest.

**Weights:**
- `+2` if adjacent to an error or resolution block
- `+1` if user message (always higher value)
- `+1` if tool call on a file that appears in the final `[Files And Changes]`
- `+1` if it's a phase boundary (first/last line of a tool-call burst)
- `0` baseline

This preserves the "story" of the session — what went wrong, what was fixed —
even under heavy truncation, instead of blindly dropping the oldest context.

**Where:** `compaction.cpp`, brief transcript capping phase. Requires a second
pass: compute weights, sort by weight, drop from bottom.

---

## Semantic Goal Deduplication

When a new goal is extracted, compare it against existing goals using character
n-gram Jaccard similarity (bigrams or trigrams). If similarity > 0.7, treat as
a refinement of the existing goal rather than a new entry.

**Before:**
```
[Session Goal]
- Fix the authentication bug in the login flow
- The login is still broken, fix it
```

**After:**
```
[Session Goal]
- Fix the authentication bug in the login flow (refined 2x)
```

**Mechanism:** extract character bigrams from each string, compute
`|intersection| / |union|`. Pure set math, no embeddings.

**Where:** `compaction.cpp`, goal extraction phase. New helper in `helpers.h`.
New config param `goalDedupThreshold` (default: 0.7).

---

## ~~Merge Conflict Detection~~ ✅ DONE

When merging summaries across compactions, detect contradictions: if an
outstanding item from the previous summary doesn't appear in the fresh summary
AND there's no resolution keyword ("fixed", "passing", "resolved") in the fresh
brief transcript, flag it as possibly unresolved.

**Before:** outstanding item silently dropped on merge.

**After:**
```
[Outstanding Context]
- [?] build failing on auth.ts (carried from previous compaction, no resolution found)
```

**Where:** `compaction.cpp`, `mergeSummaries()` function. Check previous
outstanding items against fresh transcript for resolution keywords.

---

## ~~Session Health Metrics~~ ✅ DONE

Expose compaction quality signals in the `details` object returned to Pi:

- **Goal coverage**: user messages contributing to goals / total user messages
- **Error resolution rate**: blockers resolved / blockers found
- **Tool success rate**: successful results / total results
- **Transcript compression ratio**: brief chars / raw chars

These don't change the summary but signal session state to the agent. A session
with 0% error resolution rate should trigger stronger "pick up where we left
off" behavior.

**Where:** `compaction.cpp` (collect counters during section build),
`before-compact.ts` (attach to `details` object).
