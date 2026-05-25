#ifndef PI_CC_HELPERS_H
#define PI_CC_HELPERS_H

#include <string>
#include <vector>
#include <unordered_set>

// ── Text utilities ────────────────────────────────────────────
std::string sanitize(const std::string& text);
std::string clip(const std::string& text, size_t max);
std::string clipSentence(const std::string& text, size_t max);
std::vector<std::string> nonEmptyLines(const std::string& text);
std::string firstLine(const std::string& text, size_t max);
std::string truncateWords(const std::string& text, int limit);
std::string compressBash(const std::string& raw, int cap);
std::string collapseSkillText(const std::string& text);
std::vector<std::string> collapseSkillLines(const std::vector<std::string>& lines);
std::string stripLeadingBullet(const std::string& line);
std::string wrapLongLines(const std::string& text, int maxChars);

// ── Goal deduplication ────────────────────────────────────────
// Character trigram Jaccard similarity: |intersection| / |union|
// Returns 0.0–1.0. Strings < 3 chars return 0.0.
double goalSimilarity(const std::string& a, const std::string& b);

// ── Error pattern clustering ──────────────────────────────────
// Normalize an error message by stripping variable data:
// file paths → <FILE>, line refs → line <N>, hex → <HEX>,
// quoted strings → <VAL>, bare digit runs → <N>.
std::string normalizeError(const std::string& text);

// ── Normalized block types ────────────────────────────────────
enum class BlockKind {
    USER,
    ASSISTANT,
    TOOL_CALL,
    TOOL_RESULT,
    BASH,
    THINKING
};

struct NormalizedBlock {
    BlockKind kind;
    std::string text;       // user/assistant/thinking text, or tool_result text
    std::string name;       // tool_call name, or tool_result tool name
    std::string argsJson;   // tool_call args as JSON string
    bool isError;           // tool_result isError
    std::string command;    // bash command
    std::string output;     // bash output
    int exitCode;           // bash exitCode (-1 = undefined)
    int sourceIndex;        // original message index
};

// ── Section data ──────────────────────────────────────────────
struct SectionData {
    std::vector<std::string> sessionGoal;
    std::vector<std::string> outstandingContext;
    std::vector<std::string> filesAndChanges;
    std::vector<std::string> commits;
    std::vector<std::string> userPreferences;
    std::string briefTranscript;
};

// ── Session health metrics ────────────────────────────────────
struct SectionMetrics {
    double goalCoverage = 0.0;       // user msgs contributing to goals / total user msgs
    double errorResolutionRate = 0.0; // blockers resolved / blockers found
    double toolSuccessRate = 0.0;     // successful results / total results
    double compressionRatio = 0.0;    // brief chars / raw chars
};

// ── Config ────────────────────────────────────────────────────
struct CompactionConfig {
    int truncateUserWords = 256;
    int truncateAssistantWords = 200;
    int briefMaxLines = 120;
    int toolCallsPerTurn = 8;
    int filesPerCategory = 10;
    int maxGoals = 8;
    int maxPreferences = 15;
    int maxCommits = 8;
    int maxOutstandingContext = 5;
    int maxGoalChars = 200;
    int maxPreferenceChars = 200;
    int maxOutstandingChars = 150;
    int bashCommandCap = 120;
    int toolErrorLineCap = 150;
    int correlationDepth = 2;
    int dependencyWindow = 10;
    double goalDedupThreshold = 0.7;
};

// ── Build sections (declared in compaction.cpp) ───────────────
SectionData buildSections(const std::vector<NormalizedBlock>& blocks, const CompactionConfig& config, SectionMetrics* metrics = nullptr);

// ── Recall search result ──────────────────────────────────────
struct RecallHit {
    int index;
    std::string role;
    std::string summary;
    std::string snippet;
    int matchCount;
    double score;
};

#endif // PI_CC_HELPERS_H
