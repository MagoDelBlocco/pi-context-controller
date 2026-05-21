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
};

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
