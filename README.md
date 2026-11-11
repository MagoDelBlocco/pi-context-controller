# context-controller — Deterministic Session Compaction

No-LLM, deterministic session compaction for [pi](https://github.com/badlogic/pi-mono). Same input always produces byte-identical output.

## What it does

When your session grows too large, context-controller replaces the default LLM-based compaction with a pure extraction pipeline:

1. **Splits at the last user message** — keeps the recent tail verbatim, compacts only older history
2. **Extracts working state** — current user direction, explicit decisions and reasons, successful verification commands, next step, session goal, files & changes, commits, unresolved context, user preferences
3. **Deduplicates goals** — character trigram Jaccard similarity merges near-duplicate goals into a single entry with a `(refined Nx)` suffix
4. **Clusters error patterns** — normalizes error messages (strips file paths, line numbers, hex addresses, quoted values, bare digits) and deduplicates by normalized form with an `(occurred Nx)` suffix
5. **Builds a brief transcript** — prose truncated to a word budget, tool calls collapsed to one-liners, errors kept, thinking dropped, repeats collapsed
6. **Merges across compactions** — sticky sections dedup+cap, volatile sections (unresolved context) replaced fresh, union sections (files/commits) accumulate deduped
7. **Provides a recall tool** — `recall` searches the raw, untouched session JSONL so nothing is ever truly lost

### Working-state sections

- **Current Direction** keeps the last substantive user instruction in the compacted portion. A fresh direction replaces the previous one when summaries merge. The live tail after the compaction cut remains verbatim and has priority.
- **Decisions** keeps assistant lines explicitly marked `Decision:` or `Decided:`. An immediately following `Reason:` or `Because:` line stays with the decision.
- **Verified Outcomes** records successful test, build, lint, and check commands reported by Pi's tool results. A later edit or failed bash result invalidates earlier verification in the same pass; a later compaction with file changes invalidates verification carried from an earlier pass.
- **Next Step** keeps an assistant line marked `Next:`, `Next step:`, or `Remaining:` until a later user instruction or tool action. When no explicit step remains and a blocker exists, it suggests investigating that blocker. A fresh next step replaces the earlier one.
- **User Preferences** replaces an earlier preference on a recognized topic only when the newer instruction explicitly says `instead`, `actually`, `from now on`, or `switch to`. Otherwise both remain. Arbitrary preference conflicts may still need review through `recall`.

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

The core logic is a native N-API addon that must be compiled before use. `npm install`
builds it automatically (via the `install` script); to rebuild manually run `npm run rebuild`.
If the addon is missing, compaction and `recall` will report `native addon not loaded`.

## Development

```sh
npm install        # installs deps and builds the native addon
npm run rebuild    # recompile native/ after editing the C++ sources
npm test           # run the deterministic test suite
```

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
| `correlationDepth` | `2` | How many blocks ahead to scan when pairing a tool call with its result |
| `dependencyWindow` | `10` | Sliding window of recent reads used to infer file dependencies before a write |
| `goalDedupThreshold` | `0.7` | Jaccard similarity threshold for goal deduplication (0.0–1.0; set < 0 to disable) |

## Session health metrics

Each compaction records metrics in its `details`, alongside `previousMetrics` from
the compaction before it, so the trend across compactions survives:

| Field | Meaning |
|-------|---------|
| `goalCoverage` | Share of user messages that contributed a goal line |
| `errorResolutionRate` | Blockers resolved / blockers found |
| `toolSuccessRate` | Successful tool results / all tool results |
| `compressionRatio` | Share of the raw input the brief transcript saved: `1 - briefChars / rawChars`, or `0.0` when it saved nothing |
| `rawChars` | Characters in the summarised input |
| `briefChars` | Characters in the brief transcript |

`compressionRatio` is clamped at `0.0` because a brief can legitimately be larger
than a very small input (a three-message tail with one failing command, for
example). The two absolute fields make a `0.0` unambiguous rather than suspicious.

## Recall Workflow

The `recall` tool is the safety net that makes aggressive compaction safe. Raw session history is always retrievable.

### As the LLM (via tool call)

```
recall(query: "authentication bug fix")
recall(query: "git commit", page: 2)
recall(query: "hook|inject")           # safe pattern alternative
recall(expand: [5, 12, 23])            # get full content of specific entries
recall(query: "build error", scope: "all")  # search off-lineage branches too
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
- **Pattern query** supports case-insensitive literal alternatives (`hook|inject`)
  and one `.*` wildcard between nonempty literal spans (`fail.*build`) per
  alternative. Other regex syntax is searched literally. This bounded matcher
  avoids regex backtracking stalls and ranks matches on the same BM25 scale.
- **`expand: [indices]`** → returns full untruncated content for specified entry indices
  (indices match the `#N` shown in search results and the recent view). Combines with
  `query`: the ranked search page is returned first, then the expanded entries.
  Unknown indices are named instead of dropped silently
- **`scope: "all"`** → includes off-lineage branches (default is active lineage only)

## Noise filtering

Tool calls and results from Pi bookkeeping tools are dropped before extraction:
`todo`, `recall`, and every MCP server tool (registered as `mcp__<server>__<tool>`).
Tools that carry durable signal (`read`, `edit`, `write`, `bash`, `grep`, `find`,
`ls`) are kept: Files And Changes, Commits, and the brief-transcript one-liners are
built from them.
