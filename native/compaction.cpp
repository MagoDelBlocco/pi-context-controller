#include "helpers.h"
#include <algorithm>
#include <cctype>
#include <deque>
#include <map>
#include <numeric>
#include <sstream>
#include <unordered_map>
#include <set>

// ── Noise filtering ───────────────────────────────────────────
static const std::unordered_set<std::string> NOISE_TOOLS = {
    "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
    "AskUser", "ExitSpecMode", "GenerateDroid",
};

static const std::vector<std::string> NOISE_STRINGS = {
    "Continue from where you left off.",
    "No response requested.",
    "IMPORTANT: TodoWrite was not called yet.",
};

static bool isNoiseUserBlock(const std::string& text) {
    std::string trimmed = text;
    size_t s = trimmed.find_first_not_of(" \t\r\n");
    if (s != std::string::npos) trimmed = trimmed.substr(s);
    else return true;
    size_t e = trimmed.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) trimmed = trimmed.substr(0, e + 1);
    for (const auto& ns : NOISE_STRINGS) {
        if (trimmed.find(ns) != std::string::npos) return true;
    }
    // Strip XML wrappers
    std::string stripped = trimmed;
    // Simple: remove <system-reminder>...</system-reminder> etc.
    static const char* xmlTags[] = {"system-reminder", "ide_opened_file", "command-message", "context-window-usage"};
    for (const auto* tag : xmlTags) {
        std::string openTag = "<" + std::string(tag);
        std::string closeTag = "</" + std::string(tag) + ">";
        size_t pos;
        while ((pos = stripped.find(openTag)) != std::string::npos) {
            size_t closePos = stripped.find(closeTag, pos);
            if (closePos != std::string::npos) {
                stripped.erase(pos, closePos + closeTag.size() - pos);
            } else break;
        }
    }
    // Trim again
    s = stripped.find_first_not_of(" \t\r\n");
    if (s != std::string::npos) stripped = stripped.substr(s);
    e = stripped.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) stripped = stripped.substr(0, e + 1);
    return stripped.empty();
}

static std::string cleanUserText(const std::string& text) {
    std::string stripped = text;
    static const char* xmlTags[] = {"system-reminder", "ide_opened_file", "command-message", "context-window-usage"};
    for (const auto* tag : xmlTags) {
        std::string openTag = "<" + std::string(tag);
        std::string closeTag = "</" + std::string(tag) + ">";
        size_t pos;
        while ((pos = stripped.find(openTag)) != std::string::npos) {
            size_t closePos = stripped.find(closeTag, pos);
            if (closePos != std::string::npos) {
                stripped.erase(pos, closePos + closeTag.size() - pos);
            } else break;
        }
    }
    size_t s = stripped.find_first_not_of(" \t\r\n");
    if (s != std::string::npos) stripped = stripped.substr(s);
    size_t e = stripped.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) stripped = stripped.substr(0, e + 1);
    return stripped;
}

// ── Goal extraction ───────────────────────────────────────────
static bool isSubstantiveGoal(const std::string& text, int maxChars) {
    std::string t = text;
    size_t s = t.find_first_not_of(" \t\r\n");
    if (s != std::string::npos) t = t.substr(s);
    size_t e = t.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) t = t.substr(0, e + 1);
    if (t.size() <= 5 || t.size() > static_cast<size_t>(maxChars)) return false;
    // Short noise
    static const char* noiseShort[] = {"ok", "yes", "no", "sure", "yeah", "yep", "go", "hi", "hey", "thx", "thanks", "y", "n", "k"};
    for (const auto* ns : noiseShort) {
        if (t == ns) return false;
    }
    // Non-goal patterns: code, URLs, pasted output, box-drawing, command templates
    if (!t.empty()) {
        unsigned char c = static_cast<unsigned char>(t[0]);
        // Box-drawing chars: UTF-8 first byte is 0xe2 (│├└┬┴┼╭╰╮╯─ etc.)
        if (c == 0xe2) return false;
        // ASCII paste artifacts
        if (c == '[' || c == '|' || c == '`' || c == '=' || c == '\\') return false;
        // Code patterns
        if (t.rfind("function ", 0) == 0) return false;
        if (t.rfind("const ", 0) == 0 || t.rfind("let ", 0) == 0 || t.rfind("var ", 0) == 0) return false;
        if (t.rfind("import ", 0) == 0 || t.rfind("export ", 0) == 0 || t.rfind("class ", 0) == 0) return false;
        // URLs
        if (t.rfind("https://", 0) == 0 || t.rfind("http://", 0) == 0) return false;
        if (t.rfind("file:", 0) == 0) return false;
    }
    // Command template patterns (case-insensitive)
    {
        std::string lower = t;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                      [](unsigned char c){ return std::tolower(c); });
        static const char* templatePatterns[] = {
            "for each ", "do not implement", "analyze and propose",
            "if task/", "output:", "output: a ",
        };
        for (const auto* p : templatePatterns) {
            if (lower.rfind(p, 0) == 0) return false;
        }
        // Skip lines that look like preferences (they belong in preferences, not goals)
        static const char* prefSkipPatterns[] = {
            "i prefer", "we prefer", "prefer ", "don't want", "don\'t want",
            "always use", "always do", "always run", "always keep",
            "never use", "never do", "never run", "never push",
            "please use", "please avoid", "please keep", "please make",
            "please don", "please do not", "please format",
        };
        for (const auto* p : prefSkipPatterns) {
            if (lower.find(p) != std::string::npos) return false;
        }
    }
    return true;
}

static bool hasScopeChange(const std::string& leading) {
    static const char* scopeWords[] = {"instead", "actually", "change of plan", "forget that", "new task",
        "switch to", "now I want", "pivot", "let's do", "stop "};
    std::string lower = leading;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    for (const auto* w : scopeWords) {
        if (lower.find(w) != std::string::npos) return true;
    }
    return false;
}

static bool hasTaskIntent(const std::string& leading) {
    static const char* taskWords[] = {"fix", "implement", "add", "create", "build", "refactor",
        "debug", "investigate", "update", "remove", "delete", "migrate", "deploy", "test", "write", "set up"};
    std::string lower = leading;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    for (const auto* w : taskWords) {
        if (lower.find(w) != std::string::npos) return true;
    }
    return false;
}

// ── Preference extraction ─────────────────────────────────────
static bool matchesPreferencePattern(const std::string& line) {
    std::string lower = line;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    static const char* prefPatterns[] = {
        "i prefer", "we prefer", "prefer ", "prefered", "preferring",
        "don't want", "don\'t want", "do not want",
        "always use", "always do", "always run", "always keep", "always format",
        "always write", "always add", "always include", "always append",
        "never use", "never do", "never run", "never push", "never commit",
        "never write", "never ignore", "never add", "never set",
        "please use", "please avoid", "please keep", "please make",
        "please don", "please do not", "please format", "please write",
        "style:", "style =", "format:", "format =", "language:", "language =",
        "naming:", "naming =",
    };
    for (const auto* p : prefPatterns) {
        if (lower.find(p) != std::string::npos) return true;
    }
    return false;
}

// ── File extraction ───────────────────────────────────────────
static const std::unordered_set<std::string> FILE_READ_TOOLS = {"Read", "read_file", "View"};
static const std::unordered_set<std::string> FILE_WRITE_TOOLS = {"Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"};
static const std::unordered_set<std::string> FILE_CREATE_TOOLS = {"Write", "write", "write_file"};

// Simple JSON string extraction: find value for a key
static std::string extractJsonString(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + search.size());
    if (pos == std::string::npos) return "";
    ++pos;
    // Skip whitespace
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
    if (pos >= json.size() || json[pos] != '"') return "";
    ++pos; // skip opening quote
    std::string result;
    while (pos < json.size() && json[pos] != '"') {
        if (json[pos] == '\\' && pos + 1 < json.size()) {
            ++pos;
            result += json[pos];
        } else {
            result += json[pos];
        }
        ++pos;
    }
    return result;
}

static std::string extractPath(const std::string& argsJson) {
    static const char* pathKeys[] = {"path", "file_path", "filePath", "file"};
    for (const auto* key : pathKeys) {
        std::string p = extractJsonString(argsJson, key);
        if (!p.empty()) return p;
    }
    return "";
}

// ── Commit extraction ─────────────────────────────────────────
static std::string extractCommitMessage(const std::string& cmd) {
    // Look for git commit -m "..."
    auto pos = cmd.find("git commit");
    if (pos == std::string::npos) return "";
    auto mPos = cmd.find("-m", pos);
    if (mPos == std::string::npos) return "";
    mPos += 2;
    // Skip whitespace
    while (mPos < cmd.size() && (cmd[mPos] == ' ' || cmd[mPos] == '\t')) ++mPos;
    if (mPos >= cmd.size()) return "";
    char quote = cmd[mPos];
    if (quote != '"' && quote != '\'') return "";
    ++mPos;
    std::string msg;
    while (mPos < cmd.size() && cmd[mPos] != quote) {
        if (cmd[mPos] == '\\' && mPos + 1 < cmd.size()) {
            ++mPos;
            msg += cmd[mPos];
        } else {
            msg += cmd[mPos];
        }
        ++mPos;
    }
    // Take first line
    auto nl = msg.find('\n');
    if (nl != std::string::npos) msg = msg.substr(0, nl);
    // Trim
    size_t s = msg.find_first_not_of(" \t\r\n");
    if (s != std::string::npos) msg = msg.substr(s);
    size_t e = msg.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) msg = msg.substr(0, e + 1);
    return msg;
}

static std::string extractCommitHash(const std::string& output) {
    // Look for [branch hash] or hash..hash
    // Simple: find 7-12 hex chars
    for (size_t i = 0; i < output.size(); ++i) {
        if (std::isxdigit(static_cast<unsigned char>(output[i]))) {
            size_t start = i;
            while (i < output.size() && std::isxdigit(static_cast<unsigned char>(output[i]))) ++i;
            size_t len = i - start;
            if (len >= 7 && len <= 12) {
                return output.substr(start, len);
            }
        }
    }
    return "";
}

// ── Outstanding context (resolution-aware) ────────────────────
static bool isBlockerLine(const std::string& line) {
    static const char* blockerWords[] = {"fail", "failed", "fails", "failure", "failing",
        "broken", "cannot", "can't", "won't work", "does not work", "doesn't work",
        "still broken", "still failing", "still wrong", "blocked", "blocker",
        "not fixed", "not resolved", "not working", "crash", "crashes", "crashed", "crashing"};
    std::string lower = line;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    for (const auto* w : blockerWords) {
        if (lower.find(w) != std::string::npos) return true;
    }
    return false;
}

static bool isResolutionLine(const std::string& line) {
    static const char* resolveWords[] = {"fixed", "resolved", "passing", "green",
        "working now", "works now", "solved", "corrected", "addressed"};
    std::string lower = line;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    for (const auto* w : resolveWords) {
        if (lower.find(w) != std::string::npos) return true;
    }
    return false;
}

// ── Brief transcript ──────────────────────────────────────────
static const std::unordered_map<std::string, std::string> TOOL_SUMMARY_FIELDS = {
    {"Read", "file_path"}, {"Edit", "file_path"}, {"Write", "file_path"},
    {"read", "file_path"}, {"edit", "file_path"}, {"write", "file_path"},
    {"Glob", "pattern"}, {"Grep", "pattern"},
};

static std::string toolOneLiner(const std::string& name, const std::string& argsJson) {
    auto it = TOOL_SUMMARY_FIELDS.find(name);
    if (it != TOOL_SUMMARY_FIELDS.end()) {
        std::string val = extractJsonString(argsJson, it->second);
        if (!val.empty()) return "* " + name + " \"" + val + "\"";
    }
    std::string path = extractPath(argsJson);
    if (!path.empty()) return "* " + name + " \"" + path + "\"";
    if (name == "bash" || name == "Bash") {
        std::string cmd = extractJsonString(argsJson, "command");
        if (cmd.empty()) cmd = extractJsonString(argsJson, "description");
        return "* " + name + " \"" + cmd + "\"";
    }
    std::string query = extractJsonString(argsJson, "query");
    if (!query.empty()) return "* " + name + " \"" + clip(query, 60) + "\"";
    return "* " + name;
}

// ── Main compaction function ──────────────────────────────────
SectionData buildSections(const std::vector<NormalizedBlock>& blocks, const CompactionConfig& config, SectionMetrics* metrics) {
    // Filter noise
    std::vector<NormalizedBlock> filtered;
    for (const auto& b : blocks) {
        if (b.kind == BlockKind::THINKING) continue;
        if ((b.kind == BlockKind::TOOL_CALL || b.kind == BlockKind::TOOL_RESULT) &&
            NOISE_TOOLS.find(b.name) != NOISE_TOOLS.end()) continue;
        if (b.kind == BlockKind::USER) {
            if (isNoiseUserBlock(b.text)) continue;
            NormalizedBlock cleaned = b;
            cleaned.text = cleanUserText(b.text);
            if (cleaned.text.empty()) continue;
            filtered.push_back(cleaned);
        } else {
            filtered.push_back(b);
        }
    }

    SectionData data;

    // ── Metric counters ───────────────────────────────────────
    int totalUserMsgs = 0;
    int goalContributingUserMsgs = 0;
    int totalToolResults = 0;
    int successfulToolResults = 0;
    int totalBlockers = 0;
    int resolvedBlockers = 0;
    size_t rawChars = 0;
    for (const auto& b : filtered) {
        if (b.kind == BlockKind::USER) {
            ++totalUserMsgs;
            rawChars += b.text.size();
        } else if (b.kind == BlockKind::ASSISTANT) {
            rawChars += b.text.size();
        } else if (b.kind == BlockKind::TOOL_RESULT) {
            ++totalToolResults;
            if (!b.isError) ++successfulToolResults;
            rawChars += b.text.size();
        } else if (b.kind == BlockKind::TOOL_CALL) {
            rawChars += b.argsJson.size();
        } else if (b.kind == BlockKind::BASH) {
            rawChars += b.command.size() + b.output.size();
        }
    }

    // ── Goals ─────────────────────────────────────────────────
    {
        std::vector<std::string> goals;
        std::vector<std::string> latestScopeChange;
        for (const auto& b : filtered) {
            if (b.kind != BlockKind::USER) continue;
            auto lines = collapseSkillLines(nonEmptyLines(b.text));
            // Filter substantive goals
            std::vector<std::string> goalLines;
            for (const auto& l : lines) {
                if (isSubstantiveGoal(l, config.maxGoalChars)) {
                    goalLines.push_back(stripLeadingBullet(l));
                }
            }
            goalLines.erase(
                std::remove_if(goalLines.begin(), goalLines.end(),
                    [](const std::string& s){ return s.size() <= 5; }),
                goalLines.end());
            if (!goalLines.empty()) ++goalContributingUserMsgs;
            if (goalLines.empty()) continue;

            if (goals.empty()) {
                for (size_t i = 0; i < std::min(goalLines.size(), size_t(6)); ++i) {
                    goals.push_back(goalLines[i]);
                }
                continue;
            }

            std::string leading = b.text.size() > 200 ? b.text.substr(0, 200) : b.text;
            if (hasScopeChange(leading)) {
                latestScopeChange.clear();
                for (size_t i = 0; i < std::min(goalLines.size(), size_t(3)); ++i) {
                    latestScopeChange.push_back(clip(goalLines[i], config.maxGoalChars));
                }
            } else if (hasTaskIntent(leading) && !goalLines.empty() && goalLines[0].size() > 15) {
                latestScopeChange.clear();
                for (size_t i = 0; i < std::min(goalLines.size(), size_t(2)); ++i) {
                    latestScopeChange.push_back(clip(goalLines[i], config.maxGoalChars));
                }
            }
        }
        if (!latestScopeChange.empty()) {
            goals.push_back("[Scope change]");
            goals.insert(goals.end(), latestScopeChange.begin(), latestScopeChange.end());
        }

        // ── Goal deduplication via trigram Jaccard ─────────────
        // goalDedupThreshold >= 0.0 enables dedup; < 0.0 disables it.
        if (config.goalDedupThreshold >= 0.0 && goals.size() > 1) {
            std::vector<std::string> deduped;
            std::vector<int> refineCount; // refinement count per kept goal
            for (const auto& g : goals) {
                bool merged = false;
                for (size_t j = 0; j < deduped.size(); ++j) {
                    // Skip [Scope change] markers — they are structural, not semantic
                    if (deduped[j] == "[Scope change]" || g == "[Scope change]") continue;
                    double sim = goalSimilarity(deduped[j], g);
                    if (sim >= config.goalDedupThreshold) {
                        refineCount[j]++;
                        merged = true;
                        break;
                    }
                }
                if (!merged) {
                    refineCount.push_back(0);
                    deduped.push_back(g);
                }
            }
            // Append refinement suffixes
            for (size_t i = 0; i < deduped.size(); ++i) {
                if (refineCount[i] > 0) {
                    deduped[i] += " (refined " + std::to_string(refineCount[i]) + "x)";
                }
            }
            // Remove orphaned [Scope change] markers (all their goals were merged away)
            {
                auto it = deduped.begin();
                while (it != deduped.end()) {
                    if (*it == "[Scope change]") {
                        bool hasFollowingGoals = false;
                        for (auto it2 = std::next(it); it2 != deduped.end(); ++it2) {
                            if (*it2 != "[Scope change]") { hasFollowingGoals = true; break; }
                        }
                        if (!hasFollowingGoals) {
                            it = deduped.erase(it);
                        } else {
                            ++it;
                        }
                    } else {
                        ++it;
                    }
                }
            }
            goals = std::move(deduped);
        }

        if (static_cast<int>(goals.size()) > config.maxGoals) {
            goals.resize(config.maxGoals);
        }
        data.sessionGoal = goals;
    }

    // ── Preferences ───────────────────────────────────────────
    {
        std::vector<std::string> prefs;
        std::unordered_set<std::string> seen;
        for (const auto& b : filtered) {
            if (b.kind != BlockKind::USER) continue;
            int perBlock = 0;
            for (const auto& line : nonEmptyLines(b.text)) {
                std::string trimmed = line;
                size_t s = trimmed.find_first_not_of(" \t\r\n");
                if (s != std::string::npos) trimmed = trimmed.substr(s);
                size_t e = trimmed.find_last_not_of(" \t\r\n");
                if (e != std::string::npos) trimmed = trimmed.substr(0, e + 1);
                if (trimmed.empty() || trimmed.size() < 5 || trimmed.size() > 200) continue;
                if (trimmed.back() == '?') continue;
                if (!matchesPreferencePattern(trimmed)) continue;
                std::string key = trimmed;
                std::transform(key.begin(), key.end(), key.begin(),
                              [](unsigned char c){ return std::tolower(c); });
                if (seen.find(key) != seen.end()) continue;
                seen.insert(key);
                prefs.push_back(clip(trimmed, config.maxPreferenceChars));
                if (++perBlock >= 1) break;
            }
        }
        // Dedup against goals
        std::unordered_set<std::string> goalSet;
        for (const auto& g : data.sessionGoal) {
            std::string ng = g;
            std::transform(ng.begin(), ng.end(), ng.begin(),
                          [](unsigned char c){ return std::tolower(c); });
            goalSet.insert(ng);
        }
        std::vector<std::string> deduped;
        for (const auto& p : prefs) {
            std::string np = p;
            std::transform(np.begin(), np.end(), np.begin(),
                          [](unsigned char c){ return std::tolower(c); });
            if (goalSet.find(np) == goalSet.end()) deduped.push_back(p);
        }
        if (static_cast<int>(deduped.size()) > config.maxPreferences) {
            deduped.resize(config.maxPreferences);
        }
        data.userPreferences = deduped;
    }

    // ── Files ─────────────────────────────────────────────────
    {
        std::set<std::string> readFiles, modifiedFiles, createdFiles;
        // Dependency inference: track reads in a sliding window before each write
        std::map<std::string, std::set<std::string>> fileDeps;
        std::deque<std::string> recentReads;
        int depWindow = config.dependencyWindow > 0 ? config.dependencyWindow : 10;

        for (const auto& b : filtered) {
            if (b.kind != BlockKind::TOOL_CALL) continue;
            std::string p = extractPath(b.argsJson);
            if (p.empty()) continue;
            if (FILE_READ_TOOLS.find(b.name) != FILE_READ_TOOLS.end()) {
                readFiles.insert(p);
                recentReads.push_back(p);
                if (static_cast<int>(recentReads.size()) > depWindow) recentReads.pop_front();
            }
            if (FILE_WRITE_TOOLS.find(b.name) != FILE_WRITE_TOOLS.end()) {
                modifiedFiles.insert(p);
                if (!recentReads.empty()) {
                    for (const auto& dep : recentReads) {
                        if (dep != p) fileDeps[p].insert(dep);
                    }
                }
                recentReads.clear();
            }
            if (FILE_CREATE_TOOLS.find(b.name) != FILE_CREATE_TOOLS.end()) {
                if (!recentReads.empty()) {
                    for (const auto& dep : recentReads) {
                        if (dep != p) fileDeps[p].insert(dep);
                    }
                }
                createdFiles.insert(p);
                recentReads.clear();
            }
        }
        // Dedup: if modified, remove from created
        for (const auto& p : modifiedFiles) createdFiles.erase(p);
        auto capList = [&](const std::set<std::string>& s) -> std::string {
            std::vector<std::string> v(s.begin(), s.end());
            if (static_cast<int>(v.size()) <= config.filesPerCategory) {
                std::string out;
                for (size_t i = 0; i < v.size(); ++i) {
                    if (i > 0) out += ", ";
                    out += v[i];
                }
                return out;
            }
            std::string out;
            for (int i = 0; i < config.filesPerCategory; ++i) {
                if (i > 0) out += ", ";
                out += v[i];
            }
            out += " (+" + std::to_string(v.size() - config.filesPerCategory) + " more)";
            return out;
        };
        auto depsSuffix = [&](const std::string& path) -> std::string {
            auto it = fileDeps.find(path);
            if (it != fileDeps.end() && !it->second.empty()) {
                std::string suffix = " (deps: ";
                bool first = true;
                for (const auto& d : it->second) {
                    if (!first) suffix += ", ";
                    suffix += d;
                    first = false;
                }
                suffix += ")";
                return suffix;
            }
            return "";
        };
        if (!modifiedFiles.empty()) {
            std::string line = "Modified: " + capList(modifiedFiles);
            // Append deps for first modified file if any exist
            for (const auto& p : modifiedFiles) {
                auto ds = depsSuffix(p);
                if (!ds.empty()) { line = "Modified: " + p + ds + ""; break; }
            }
            data.filesAndChanges.push_back(line);
        }
        if (!createdFiles.empty()) {
            std::string line = "Created: " + capList(createdFiles);
            for (const auto& p : createdFiles) {
                auto ds = depsSuffix(p);
                if (!ds.empty()) { line = "Created: " + p + ds + ""; break; }
            }
            data.filesAndChanges.push_back(line);
        }
        if (!readFiles.empty()) data.filesAndChanges.push_back("Read: " + capList(readFiles));
    }

    // ── Commits ───────────────────────────────────────────────
    {
        std::vector<std::pair<std::string, std::string>> commits; // hash, message
        for (size_t i = 0; i < filtered.size(); ++i) {
            const auto& b = filtered[i];
            if (b.kind != BlockKind::TOOL_CALL || b.name != "bash") continue;
            std::string msg = extractCommitMessage(b.text); // For tool_call, text holds the command
            if (msg.empty()) continue;
            std::string hash;
            // Look at next tool_result for hash
            for (size_t j = i + 1; j < std::min(filtered.size(), i + 3); ++j) {
                if (filtered[j].kind == BlockKind::TOOL_RESULT) {
                    hash = extractCommitHash(filtered[j].text);
                    if (!hash.empty()) break;
                }
            }
            // Dedup
            bool dup = false;
            for (const auto& c : commits) {
                if (c.second == msg && c.first == hash) { dup = true; break; }
            }
            if (!dup) commits.push_back({hash, msg});
        }
        // Keep most recent
        if (static_cast<int>(commits.size()) > config.maxCommits) {
            commits.erase(commits.begin(), commits.end() - config.maxCommits);
        }
        for (const auto& c : commits) {
            std::string line = c.first.empty() ? c.second : c.first + ": " + c.second;
            data.commits.push_back(line);
        }
    }

    // ── Outstanding Context (resolution-aware) ────────────────
    {
        // Look at last N blocks
        size_t startIdx = filtered.size() > 20 ? filtered.size() - 20 : 0;
        // Collect blockers with their indices
        struct BlockerInfo {
            int idx;
            std::string text;
            std::string target; // simplified target for resolution matching
        };
        std::vector<BlockerInfo> blockers;
        for (size_t i = startIdx; i < filtered.size(); ++i) {
            const auto& b = filtered[i];
            if (b.kind == BlockKind::TOOL_RESULT && b.isError) {
                blockers.push_back({static_cast<int>(i),
                    "[" + b.name + "] " + firstLine(b.text, config.maxOutstandingChars),
                    b.name});
                continue;
            }
            if (b.kind == BlockKind::ASSISTANT || b.kind == BlockKind::USER) {
                for (const auto& line : nonEmptyLines(b.text)) {
                    if (!isBlockerLine(line)) continue;
                    if (line.size() < 15) continue;
                    // Skip sub-bullets
                    if (!line.empty() && (line[0] == '-' || line[0] == '*' || line[0] == '+' || line[0] == '>')) continue;
                    if (!line.empty() && line[0] == '(') continue;
                    std::string clipped = b.kind == BlockKind::USER
                        ? "[user] " + clipSentence(line, config.maxOutstandingChars)
                        : clipSentence(line, config.maxOutstandingChars);
                    blockers.push_back({static_cast<int>(i), clipped, ""});
                    break;
                }
            }
        }
        // Resolution-aware: suppress blockers that are later resolved
        std::vector<std::string> outstanding;
        for (const auto& bl : blockers) {
            bool resolved = false;
            // Check if any later block resolves it
            for (size_t i = static_cast<size_t>(bl.idx) + 1; i < filtered.size(); ++i) {
                const auto& later = filtered[i];
                if (later.kind == BlockKind::ASSISTANT || later.kind == BlockKind::USER) {
                    if (isResolutionLine(later.text)) { resolved = true; break; }
                }
                if (later.kind == BlockKind::TOOL_RESULT && !later.isError) {
                    // A successful tool result after a blocker on same tool
                    if (bl.target == later.name) { resolved = true; break; }
                }
            }
            ++totalBlockers;
            if (resolved) ++resolvedBlockers;
            if (!resolved) {
                outstanding.push_back(bl.text);
                if (static_cast<int>(outstanding.size()) >= config.maxOutstandingContext) break;
            }
        }

        // ── Error pattern clustering ──────────────────────────
        // Normalize error messages and deduplicate by normalized form.
        // First occurrence kept with (occurred Nx) suffix for duplicates.
        {
            std::vector<std::string> clustered;
            std::vector<int> clusterCount;
            for (const auto& item : outstanding) {
                std::string norm = normalizeError(item);
                bool merged = false;
                for (size_t j = 0; j < clustered.size(); ++j) {
                    if (norm == normalizeError(clustered[j])) {
                        clusterCount[j]++;
                        merged = true;
                        break;
                    }
                }
                if (!merged) {
                    clusterCount.push_back(1);
                    clustered.push_back(item);
                }
            }
            // Append occurrence suffixes
            for (size_t i = 0; i < clustered.size(); ++i) {
                if (clusterCount[i] > 1) {
                    clustered[i] += " (occurred " + std::to_string(clusterCount[i]) + "x)";
                }
            }
            outstanding = std::move(clustered);
        }

        data.outstandingContext = outstanding;
    }

    // ── Brief Transcript ──────────────────────────────────────
    {
        struct BriefSection {
            std::string header;
            std::vector<std::string> lines;
        };
        std::vector<BriefSection> sections;
        std::string lastHeader;

        auto push = [&](const std::string& header, const std::string& line) {
            if (header == lastHeader && !sections.empty()) {
                sections.back().lines.push_back(line);
                return;
            }
            sections.push_back({header, {line}});
            lastHeader = header;
        };

        for (size_t i = 0; i < filtered.size(); ++i) {
            const auto& b = filtered[i];
            switch (b.kind) {
                case BlockKind::USER: {
                    if (b.text.empty()) break;
                    std::string text = truncateWords(collapseSkillText(b.text), config.truncateUserWords);
                    if (!text.empty()) {
                        std::string ref = b.sourceIndex >= 0 ? " (#" + std::to_string(b.sourceIndex) + ")" : "";
                        push("[user]", text + ref);
                    }
                    lastHeader = "[user]";
                    break;
                }
                case BlockKind::BASH: {
                    std::string cmd = compressBash(b.command, config.bashCommandCap);
                    if (!cmd.empty()) {
                        std::string ref = b.sourceIndex >= 0 ? " (#" + std::to_string(b.sourceIndex) + ")" : "";
                        push("[user]", "$ " + cmd + ref);
                    }
                    lastHeader = "[user]";
                    break;
                }
                case BlockKind::ASSISTANT: {
                    std::string text = truncateWords(b.text, config.truncateAssistantWords);
                    if (!text.empty()) {
                        std::string ref = b.sourceIndex >= 0 ? " (#" + std::to_string(b.sourceIndex) + ")" : "";
                        push("[assistant]", text + ref);
                    }
                    break;
                }
                case BlockKind::TOOL_CALL: {
                    if (b.name.empty()) break;
                    std::string summary = toolOneLiner(b.name, b.argsJson);
                    int firstIdx = b.sourceIndex;
                    int lastIdx = b.sourceIndex;

                    // Correlation: peek ahead for matching tool_result
                    int depth = config.correlationDepth > 0 ? config.correlationDepth : 2;
                    for (int d = 0; d < depth; ++d) {
                        bool found = false;
                        size_t start = i + 1;
                        size_t end = std::min(filtered.size(), start + static_cast<size_t>(depth));
                        for (size_t k = start; k < end; ++k) {
                            if (filtered[k].kind == BlockKind::TOOL_RESULT && filtered[k].name == b.name) {
                                lastIdx = filtered[k].sourceIndex;
                                if (filtered[k].isError) {
                                    std::string body = firstLine(filtered[k].text, config.toolErrorLineCap);
                                    if (!body.empty() && body != "(no output)") {
                                        summary += " \xe2\x86\x92 " + body;
                                    }
                                }
                                i = k;
                                found = true;
                                break;
                            }
                        }
                        if (!found) break;
                    }

                    std::string ref;
                    if (firstIdx >= 0) {
                        ref = " (#" + std::to_string(firstIdx);
                        if (lastIdx != firstIdx && lastIdx >= 0) ref += "-" + std::to_string(lastIdx);
                        ref += ")";
                    }
                    push("[assistant]", summary + ref);
                    break;
                }
                case BlockKind::TOOL_RESULT: {
                    if (b.isError) {
                        std::string body = firstLine(b.text, config.toolErrorLineCap);
                        if (!body.empty() && body != "(no output)") {
                            std::string ref = b.sourceIndex >= 0 ? " (#" + std::to_string(b.sourceIndex) + ")" : "";
                            std::string header = "[tool_error] " + b.name + ref;
                            push(header, body);
                            lastHeader = header;
                        }
                    }
                    break;
                }
                case BlockKind::THINKING:
                    break;
            }
        }

        // Cap tool calls per assistant turn
        for (auto& sec : sections) {
            if (sec.header != "[assistant]") continue;
            std::vector<int> toolIdxs;
            for (int i = 0; i < static_cast<int>(sec.lines.size()); ++i) {
                if (sec.lines[i].size() >= 2 && sec.lines[i][0] == '*' && sec.lines[i][1] == ' ') {
                    toolIdxs.push_back(i);
                }
            }
            if (static_cast<int>(toolIdxs.size()) > config.toolCallsPerTurn) {
                int dropCount = static_cast<int>(toolIdxs.size()) - config.toolCallsPerTurn;
                std::set<int> dropSet(toolIdxs.begin(), toolIdxs.begin() + dropCount);
                std::vector<std::string> next;
                bool inserted = false;
                for (int i = 0; i < static_cast<int>(sec.lines.size()); ++i) {
                    if (dropSet.find(i) != dropSet.end()) continue;
                    if (!inserted && !toolIdxs.empty() && i == toolIdxs[dropCount]) {
                        next.push_back("* (" + std::to_string(dropCount) + " earlier tool-call entries omitted)");
                        inserted = true;
                    }
                    next.push_back(sec.lines[i]);
                }
                sec.lines = next;
            }
        }

        // Stringify
        std::string brief;
        for (size_t i = 0; i < sections.size(); ++i) {
            bool prevIsTools = (i > 0 && sections[i-1].header == "[assistant]" &&
                std::all_of(sections[i-1].lines.begin(), sections[i-1].lines.end(),
                    [](const std::string& l){ return l.size() >= 2 && l[0] == '*' && l[1] == ' '; }));
            bool curIsTools = (sections[i].header == "[assistant]" &&
                std::all_of(sections[i].lines.begin(), sections[i].lines.end(),
                    [](const std::string& l){ return l.size() >= 2 && l[0] == '*' && l[1] == ' '; }));
            if (i > 0 && !(prevIsTools && curIsTools)) brief += '\n';
            brief += sections[i].header;
            brief += '\n';
            for (const auto& line : sections[i].lines) {
                brief += line;
                brief += '\n';
            }
        }
        // Remove trailing newline
        if (!brief.empty() && brief.back() == '\n') brief.pop_back();

        // Cap lines
        auto briefLines = nonEmptyLines(brief);
        // Re-split preserving structure
        std::istringstream iss(brief);
        std::vector<std::string> allLines;
        std::string line;
        while (std::getline(iss, line)) allLines.push_back(line);
        if (static_cast<int>(allLines.size()) > config.briefMaxLines) {
            int omitted = static_cast<int>(allLines.size()) - config.briefMaxLines;
            brief = "...(" + std::to_string(omitted) + " earlier lines omitted)\n\n";
            for (int i = static_cast<int>(allLines.size()) - config.briefMaxLines; i < static_cast<int>(allLines.size()); ++i) {
                if (i > static_cast<int>(allLines.size()) - config.briefMaxLines) brief += '\n';
                brief += allLines[i];
            }
        } else {
            brief = std::accumulate(allLines.begin(), allLines.end(), std::string(),
                [](const std::string& a, const std::string& b){ return a + "\n" + b; });
        }
        data.briefTranscript = brief;
    }

    // ── Emit metrics ──────────────────────────────────────────
    if (metrics) {
        metrics->goalCoverage = totalUserMsgs > 0
            ? static_cast<double>(goalContributingUserMsgs) / totalUserMsgs
            : 0.0;
        metrics->errorResolutionRate = totalBlockers > 0
            ? static_cast<double>(resolvedBlockers) / totalBlockers
            : 0.0;
        metrics->toolSuccessRate = totalToolResults > 0
            ? static_cast<double>(successfulToolResults) / totalToolResults
            : 0.0;
        metrics->compressionRatio = rawChars > 0
            ? static_cast<double>(data.briefTranscript.size()) / rawChars
            : 0.0;
    }

    return data;
}

// ── Format summary ────────────────────────────────────────────
static std::string section(const std::string& title, const std::vector<std::string>& items) {
    if (items.empty()) return "";
    std::string body = "[" + title + "]";
    for (const auto& item : items) {
        body += "\n- " + item;
    }
    return body;
}

std::string formatSummary(const SectionData& data) {
    std::vector<std::string> parts;
    std::string headers;
    auto addSection = [&](const std::string& s) {
        if (!s.empty()) {
            if (!headers.empty()) headers += "\n\n";
            headers += s;
        }
    };
    addSection(section("Session Goal", data.sessionGoal));
    addSection(section("Files And Changes", data.filesAndChanges));
    addSection(section("Commits", data.commits));
    addSection(section("Outstanding Context", data.outstandingContext));
    addSection(section("User Preferences", data.userPreferences));

    if (!headers.empty()) parts.push_back(headers);
    if (!data.briefTranscript.empty()) parts.push_back(data.briefTranscript);

    if (parts.empty()) return "";
    std::string result;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) result += "\n\n---\n\n";
        result += parts[i];
    }
    return wrapLongLines(result, 120);
}

// ── Merge previous summary ────────────────────────────────────
static const std::vector<std::string> HEADER_NAMES = {
    "Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"
};

static std::string sectionOf(const std::string& text, const std::string& header) {
    std::string tag = "[" + header + "]";
    size_t start = text.find(tag);
    if (start == std::string::npos) return "";
    std::string after = text.substr(start);
    size_t nextEnd = std::string::npos;
    for (const auto& h : HEADER_NAMES) {
        if (h == header) continue;
        std::string otherTag = "[" + h + "]";
        size_t pos = after.find(otherTag);
        if (pos > 0 && (nextEnd == std::string::npos || pos < nextEnd)) nextEnd = pos;
    }
    size_t sepPos = after.find("\n\n---\n\n");
    if (sepPos > 0 && (nextEnd == std::string::npos || sepPos < nextEnd)) nextEnd = sepPos;
    std::string result = (nextEnd != std::string::npos) ? after.substr(0, nextEnd) : after;
    // Trim
    size_t e = result.find_last_not_of(" \t\r\n");
    if (e != std::string::npos) result = result.substr(0, e + 1);
    return result;
}

static std::string briefOf(const std::string& text) {
    std::string sep = "\n\n---\n\n";
    size_t idx = text.find(sep);
    if (idx == std::string::npos) return "";
    return text.substr(idx + sep.size());
}

std::string mergeSummaries(const std::string& previous, const std::string& fresh, const CompactionConfig& config) {
    if (previous.empty()) return fresh;
    if (fresh.empty()) return previous;

    // Merge header sections
    std::vector<std::string> mergedHeaders;
    for (const auto& header : HEADER_NAMES) {
        std::string prevSec = sectionOf(previous, header);
        std::string freshSec = sectionOf(fresh, header);

        // Outstanding Context: merge with conflict detection
        if (header == "Outstanding Context") {
            // Extract previous outstanding items
            std::vector<std::string> prevItems;
            for (const auto& line : nonEmptyLines(prevSec)) {
                if (line.size() >= 2 && line[0] == '-' && line[1] == ' ') {
                    prevItems.push_back(line.substr(2));
                }
            }
            // Extract fresh outstanding items
            std::vector<std::string> freshItems;
            for (const auto& line : nonEmptyLines(freshSec)) {
                if (line.size() >= 2 && line[0] == '-' && line[1] == ' ') {
                    freshItems.push_back(line.substr(2));
                }
            }
            // Get fresh brief transcript for resolution checking
            std::string freshBrief = briefOf(fresh);

            // Check previous items not in fresh — flag unresolved ones
            std::vector<std::string> carried;
            for (const auto& prevItem : prevItems) {
                bool inFresh = false;
                for (const auto& fItem : freshItems) {
                    if (prevItem == fItem) { inFresh = true; break; }
                }
                if (inFresh) continue;
                // Check if resolved in fresh brief transcript
                bool resolved = false;
                for (const auto& blLine : nonEmptyLines(freshBrief)) {
                    if (isResolutionLine(blLine)) { resolved = true; break; }
                }
                if (!resolved) {
                    carried.push_back("[?] " + prevItem + " (carried from previous compaction, no resolution found)");
                }
            }
            // Combine: fresh items first, then carried items, capped
            std::vector<std::string> merged;
            for (const auto& item : freshItems) merged.push_back(item);
            for (const auto& item : carried) merged.push_back(item);
            if (static_cast<int>(merged.size()) > config.maxOutstandingContext) {
                merged.resize(config.maxOutstandingContext);
            }
            if (!merged.empty()) {
                std::string out = "[Outstanding Context]";
                for (const auto& item : merged) out += "\n- " + item;
                mergedHeaders.push_back(out);
            }
            continue;
        }
        if (prevSec.empty()) { if (!freshSec.empty()) mergedHeaders.push_back(freshSec); continue; }
        if (freshSec.empty()) { mergedHeaders.push_back(prevSec); continue; }

        // Files And Changes: merge by category
        if (header == "Files And Changes") {
            std::set<std::string> modified, created, read;
            auto parseFileLines = [&](const std::string& text, const std::string& prefix, std::set<std::string>& target) {
                std::string marker = "- " + prefix + ": ";
                size_t pos = 0;
                while ((pos = text.find(marker, pos)) != std::string::npos) {
                    pos += marker.size();
                    size_t end = text.find('\n', pos);
                    std::string rest = (end == std::string::npos) ? text.substr(pos) : text.substr(pos, end - pos);
                    // Strip (+N more)
                    auto plusPos = rest.rfind("(+");
                    if (plusPos != std::string::npos) rest = rest.substr(0, plusPos);
                    // Split by comma
                    std::istringstream iss(rest);
                    std::string path;
                    while (std::getline(iss, path, ',')) {
                        size_t s = path.find_first_not_of(" \t");
                        if (s != std::string::npos) path = path.substr(s);
                        size_t e = path.find_last_not_of(" \t");
                        if (e != std::string::npos) path = path.substr(0, e + 1);
                        if (!path.empty()) target.insert(path);
                    }
                    pos = end;
                }
            };
            for (const auto& t : {prevSec, freshSec}) {
                parseFileLines(t, "Modified", modified);
                parseFileLines(t, "Created", created);
                parseFileLines(t, "Read", read);
            }
            for (const auto& p : modified) created.erase(p);
            std::string merged;
            auto capStr = [&](const std::set<std::string>& s) -> std::string {
                std::vector<std::string> v(s.begin(), s.end());
                if (static_cast<int>(v.size()) <= config.filesPerCategory) {
                    std::string out;
                    for (size_t i = 0; i < v.size(); ++i) {
                        if (i > 0) out += ", ";
                        out += v[i];
                    }
                    return out;
                }
                std::string out;
                for (int i = 0; i < config.filesPerCategory; ++i) {
                    if (i > 0) out += ", ";
                    out += v[i];
                }
                out += " (+" + std::to_string(v.size() - config.filesPerCategory) + " more)";
                return out;
            };
            if (!modified.empty()) merged += "- Modified: " + capStr(modified) + "\n";
            if (!created.empty()) merged += "- Created: " + capStr(created) + "\n";
            if (!read.empty()) merged += "- Read: " + capStr(read) + "\n";
            if (!merged.empty()) {
                merged = "[Files And Changes]\n" + merged;
                // Trim trailing newline
                while (!merged.empty() && merged.back() == '\n') merged.pop_back();
                mergedHeaders.push_back(merged);
            }
            continue;
        }

        // Session Goal, Commits, User Preferences: line-level dedup, cap
        auto isCleanLine = [](const std::string& l) {
            return l.size() >= 2 && l[0] == '-' && l[1] == ' ';
        };
        std::set<std::string> combined;
        for (const auto& t : {prevSec, freshSec}) {
            for (const auto& line : nonEmptyLines(t)) {
                if (isCleanLine(line)) combined.insert(line);
            }
        }
        int cap = (header == "Session Goal" || header == "Commits") ? config.maxGoals : config.maxPreferences;
        std::vector<std::string> vec(combined.begin(), combined.end());
        if (static_cast<int>(vec.size()) > cap) {
            vec.erase(vec.begin(), vec.end() - cap);
        }
        if (!vec.empty()) {
            std::string merged = "[" + header + "]";
            for (const auto& l : vec) merged += "\n" + l;
            mergedHeaders.push_back(merged);
        }
    }

    // Merge brief transcript
    std::string prevBrief = briefOf(previous);
    std::string freshBrief = briefOf(fresh);
    std::string mergedBrief;
    if (!prevBrief.empty() && !freshBrief.empty()) mergedBrief = prevBrief + "\n\n" + freshBrief;
    else if (!prevBrief.empty()) mergedBrief = prevBrief;
    else mergedBrief = freshBrief;

    std::string result;
    for (size_t i = 0; i < mergedHeaders.size(); ++i) {
        if (i > 0) result += "\n\n";
        result += mergedHeaders[i];
    }
    if (!mergedBrief.empty()) {
        if (!result.empty()) result += "\n\n---\n\n";
        result += mergedBrief;
    }
    return wrapLongLines(result, 120);
}
