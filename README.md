# context-controller — Deterministic Session Compaction

No-LLM, deterministic session compaction for [pi](https://github.com/badlogic/pi-mono). Same input always produces byte-identical output.

## What it does

When your session grows too large, context-controller replaces the default LLM-based compaction with a pure extraction pipeline:

1. **Splits at the last user message** — keeps the recent tail verbatim, compacts only older history
2. **Extracts trusted sections** — session goal, files & changes, commits, unresolved context, user preferences
3. **Deduplicates goals** — character trigram Jaccard similarity merges near-duplicate goals into a single entry with a `(refined Nx)` suffix
4. **Clusters error patterns** — normalizes error messages (strips file paths, line numbers, hex addresses, quoted values, bare digits) and deduplicates by normalized form with an `(occurred Nx)` suffix
5. **Builds a brief transcript** — prose truncated to a word budget, tool calls collapsed to one-liners, errors kept, thinking dropped, repeats collapsed
6. **Merges across compactions** — sticky sections dedup+cap, volatile sections (unresolved context) replaced fresh, union sections (files/commits) accumulate deduped
7. **Provides a recall tool** — `cc_recall` searches the raw, untouched session JSONL so nothing is ever truly lost

## Improvements over pi-vcc

| Feature | pi-vcc | context-controller |
|---------|--------|-------|
| Configurable caps | Hardcoded | All limits in config file |
| Unresolved context | Flags anything matching "fail/broken" | Resolution-aware: suppresses blockers that were later fixed |
| Goal/pref false positives | Basic regex | Hardened corpus-tested patterns (rejects code, URLs, box-drawing, command templates) |
| Core logic | TypeScript | C++ via N-API (faster, deterministic) |
| Goal deduplication | None | Trigram Jaccard similarity with `(refined Nx)` suffix |
| Error clustering | None | Normalizes paths/hex/quotes/digits, deduplicates with `(occurred Nx)` suffix |

## Installation

context-controller is already in your extensions directory. It replaces the default Pi compactor by default — on each auto-compaction you'll see a dialog asking how to proceed.

## First-run dialog

When auto-compaction triggers, context-controller shows:

```
┌─ context-controller ────────────────────────────────────────┐
│ Compact with algorithmic summary?              │
│                                                │
│ →  Yes — use context-controller                             │
│     Don't compact yet                          │
│     Use LLM-based compaction                   │
│                                                │
│ ↑↓ navigate  •  enter confirm  •  esc cancel   │
└────────────────────────────────────────────────┘
```

- **Yes — use context-controller** → compacts with the deterministic pipeline
- **Don't compact yet** → cancels compaction, context stays as-is
- **Use LLM-based compaction** → falls through to Pi's default LLM compactor

To skip this dialog after choosing once, set `skipConfirmation: true` in config.

To use context-controller on-demand without overriding auto-compaction, use `/context-controller` (no dialog).

## Configuration

Config file: `~/.pi/agent/context-controller-config.json` (auto-created with defaults on first run).

| Key | Default | Description |
|-----|---------|-------------|
| `overrideDefaultCompaction` | `true` | Handle all compactions (auto + `/compact`) |
| `skipConfirmation` | `false` | Skip the 3-choice dialog on auto-compaction |
| `debug` | `false` | Write debug snapshots to `/tmp/context-controller-debug.json` |
| `truncateUserWords` | `256` | Max words for user prose in brief transcript |
| `truncateAssistantWords` | `200` | Max words for assistant prose in brief transcript |
| `briefMaxLines` | `120` | Max total lines in brief transcript before capping |
| `toolCallsPerTurn` | `8` | Max tool-call one-liners kept per assistant turn (tail kept) |
| `filesPerCategory` | `10` | Max files listed per category (Modified/Created/Read) |
| `maxGoals` | `8` | Max session goal lines |
| `maxPreferences` | `15` | Max user preference lines |
| `maxCommits` | `8` | Max commit lines |
| `maxOutstandingContext` | `5` | Max outstanding context items |
| `maxGoalChars` | `200` | Max chars per goal line |
| `maxPreferenceChars` | `200` | Max chars per preference line |
| `maxOutstandingChars` | `150` | Max chars per outstanding context item |
| `bashCommandCap` | `120` | Max chars for bash command in brief |
| `toolErrorLineCap` | `150` | Max chars for tool error first line |
| `goalDedupThreshold` | `0.7` | Jaccard similarity threshold for goal deduplication (0.0–1.0; set < 0 to disable) |

## Recall Workflow

The `cc_recall` tool is the safety net that makes aggressive compaction safe. Raw session history is always retrievable.

### As the LLM (via tool call)

```
cc_recall(query: "authentication bug fix")
cc_recall(query: "git commit", page: 2)
cc_recall(query: "hook|inject")           # regex pattern
cc_recall(expand: [5, 12, 23])            # get full content of specific entries
cc_recall(query: "build error", scope: "all")  # search off-lineage branches too
```

### As the user (via slash command)

```
/context-controller-recall authentication bug fix
/context-controller-recall git commit page:2
/context-controller-recall scope:all                   # show recent from all branches
```

### Key behaviors

- **No query** → shows the 25 most recent entries
- **Multi-word query** → BM25-ranked, paginated (5 per page)
- **Regex pattern** (contains `|*+?{}()[\]\\^$.`) → treated as single regex
- **`expand: [indices]`** → returns full untruncated content for specified entry indices
- **`scope: "all"`** → includes off-lineage branches (default is active lineage only)

## Summary
