#include <napi.h>
#include <string>
#include <vector>
#include "helpers.h"

// Forward declarations from compaction.cpp
extern SectionData buildSections(const std::vector<NormalizedBlock>& blocks, const CompactionConfig& config);
extern std::string formatSummary(const SectionData& data);
extern std::string mergeSummaries(const std::string& previous, const std::string& fresh, const CompactionConfig& config);

// Forward declarations from recall.cpp
extern std::vector<RecallHit> searchEntries(
    const std::vector<std::string>& roles,
    const std::vector<std::string>& summaries,
    const std::vector<std::string>& fullTexts,
    const std::string& query);

// ── JSON escape helper ────────────────────────────────────────
static std::string escapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// ── Delimiter-based parsing ───────────────────────────────────
// Blocks are passed as a single string with \x01 between blocks and \x02 between fields.
// Fields per block: kind|text|name|argsJson|isError|command|output|exitCode|sourceIndex
// This avoids JSON parsing in C++.

static std::vector<std::string> splitOn(const std::string& s, char delim) {
    std::vector<std::string> parts;
    std::string cur;
    for (char c : s) {
        if (c == delim) { parts.push_back(cur); cur.clear(); }
        else cur += c;
    }
    parts.push_back(cur);
    return parts;
}

static BlockKind blockKindFromStr(const std::string& s) {
    if (s == "user") return BlockKind::USER;
    if (s == "assistant") return BlockKind::ASSISTANT;
    if (s == "tool_call") return BlockKind::TOOL_CALL;
    if (s == "tool_result") return BlockKind::TOOL_RESULT;
    if (s == "bash") return BlockKind::BASH;
    if (s == "thinking") return BlockKind::THINKING;
    return BlockKind::USER;
}

static std::vector<NormalizedBlock> parseBlocks(const std::string& raw) {
    std::vector<NormalizedBlock> blocks;
    auto blockStrs = splitOn(raw, '\x01');
    for (const auto& blockStr : blockStrs) {
        if (blockStr.empty()) continue;
        auto fields = splitOn(blockStr, '\x02');
        if (fields.size() < 9) continue;
        NormalizedBlock b;
        b.kind = blockKindFromStr(fields[0]);
        b.text = fields[1];
        b.name = fields[2];
        b.argsJson = fields[3];
        b.isError = (fields[4] == "1");
        b.command = fields[5];
        b.output = fields[6];
        try { b.exitCode = std::stoi(fields[7]); } catch (...) { b.exitCode = -1; }
        try { b.sourceIndex = std::stoi(fields[8]); } catch (...) { b.sourceIndex = -1; }
        blocks.push_back(b);
    }
    return blocks;
}

// ── Config parsing ────────────────────────────────────────────
// Config passed as key=value pairs separated by \x02
static CompactionConfig parseConfig(const std::string& raw) {
    CompactionConfig config;
    auto pairs = splitOn(raw, '\x02');
    for (const auto& pair : pairs) {
        auto eq = pair.find('=');
        if (eq == std::string::npos) continue;
        std::string key = pair.substr(0, eq);
        std::string val = pair.substr(eq + 1);
        int v = 0;
        try { v = std::stoi(val); } catch (...) { continue; }
        if (key == "truncateUserWords") config.truncateUserWords = v;
        else if (key == "truncateAssistantWords") config.truncateAssistantWords = v;
        else if (key == "briefMaxLines") config.briefMaxLines = v;
        else if (key == "toolCallsPerTurn") config.toolCallsPerTurn = v;
        else if (key == "filesPerCategory") config.filesPerCategory = v;
        else if (key == "maxGoals") config.maxGoals = v;
        else if (key == "maxPreferences") config.maxPreferences = v;
        else if (key == "maxCommits") config.maxCommits = v;
        else if (key == "maxOutstandingContext") config.maxOutstandingContext = v;
        else if (key == "maxGoalChars") config.maxGoalChars = v;
        else if (key == "maxPreferenceChars") config.maxPreferenceChars = v;
        else if (key == "maxOutstandingChars") config.maxOutstandingChars = v;
        else if (key == "bashCommandCap") config.bashCommandCap = v;
        else if (key == "toolErrorLineCap") config.toolErrorLineCap = v;
        else if (key == "correlationDepth") config.correlationDepth = v;
        else if (key == "dependencyWindow") config.dependencyWindow = v;
        else if (key == "goalDedupThreshold") config.goalDedupThreshold = std::stod(val);
    }
    return config;
}

// ── N-API exports ─────────────────────────────────────────────

/*
 * buildSections(blocksRaw, configRaw) -> JSON string
 *
 * blocksRaw: delimited string (see parseBlocks)
 * configRaw: delimited string (see parseConfig)
 * Returns: JSON string of SectionData
 */
Napi::String BuildSections(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string blocksRaw = info[0].As<Napi::String>().Utf8Value();
    std::string configRaw = info[1].As<Napi::String>().Utf8Value();

    auto blocks = parseBlocks(blocksRaw);
    auto config = parseConfig(configRaw);

    SectionMetrics metrics;
    SectionData data = buildSections(blocks, config, &metrics);

    // Build JSON output
    std::string json = "{";
    auto addStrArr = [&](const char* key, const std::vector<std::string>& arr) {
        json += "\"" + std::string(key) + "\":[";
        for (size_t i = 0; i < arr.size(); ++i) {
            if (i > 0) json += ",";
            json += "\"" + escapeJson(arr[i]) + "\"";
        }
        json += "],";
    };
    addStrArr("sessionGoal", data.sessionGoal);
    addStrArr("outstandingContext", data.outstandingContext);
    addStrArr("filesAndChanges", data.filesAndChanges);
    addStrArr("commits", data.commits);
    addStrArr("userPreferences", data.userPreferences);
    json += "\"briefTranscript\":\"" + escapeJson(data.briefTranscript) + "\"";
    json += ",\"metrics\":{\"goalCoverage\":" + std::to_string(metrics.goalCoverage)
         + ",\"errorResolutionRate\":" + std::to_string(metrics.errorResolutionRate)
         + ",\"toolSuccessRate\":" + std::to_string(metrics.toolSuccessRate)
         + ",\"compressionRatio\":" + std::to_string(metrics.compressionRatio) + "}";
    json += "}";

    return Napi::String::New(env, json);
}

/*
 * formatSummary(sectionsJson) -> string
 *
 * sectionsJson: JSON object from buildSections
 * Returns: formatted summary string
 */
Napi::String FormatSummary(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string json = info[0].As<Napi::String>().Utf8Value();

    // Minimal JSON parsing for our known structure
    auto extractArr = [&](const char* key) -> std::vector<std::string> {
        std::vector<std::string> arr;
        std::string search = "\"" + std::string(key) + "\":[";
        size_t pos = json.find(search);
        if (pos == std::string::npos) return arr;
        pos += search.size();
        // Find matching ]
        int depth = 1;
        size_t start = pos;
        while (pos < json.size() && depth > 0) {
            if (json[pos] == '[') ++depth;
            else if (json[pos] == ']') --depth;
            else if (json[pos] == '"') {
                ++pos; // skip opening quote
                while (pos < json.size() && json[pos] != '"') {
                    if (json[pos] == '\\') ++pos;
                    ++pos;
                }
            }
            ++pos;
        }
        std::string arrStr = json.substr(start, pos - start - 1);
        // Parse strings from array
        size_t sp = 0;
        while (sp < arrStr.size()) {
            while (sp < arrStr.size() && arrStr[sp] != '"') ++sp;
            if (sp >= arrStr.size()) break;
            ++sp; // skip opening quote
            size_t strStart = sp;
            while (sp < arrStr.size() && arrStr[sp] != '"') {
                if (arrStr[sp] == '\\') ++sp;
                ++sp;
            }
            std::string val = arrStr.substr(strStart, sp - strStart);
            // Unescape
            std::string unescaped;
            for (size_t i = 0; i < val.size(); ++i) {
                if (val[i] == '\\' && i + 1 < val.size()) {
                    switch (val[i + 1]) {
                        case '"': unescaped += '"'; ++i; break;
                        case '\\': unescaped += '\\'; ++i; break;
                        case 'n': unescaped += '\n'; ++i; break;
                        case 'r': unescaped += '\r'; ++i; break;
                        case 't': unescaped += '\t'; ++i; break;
                        default: unescaped += val[i]; break;
                    }
                } else {
                    unescaped += val[i];
                }
            }
            arr.push_back(unescaped);
            if (sp < arrStr.size()) ++sp; // skip closing quote
        }
        return arr;
    };

    auto extractStr = [&](const char* key) -> std::string {
        std::string search = "\"" + std::string(key) + "\":";
        size_t pos = json.find(search);
        if (pos == std::string::npos) return "";
        pos += search.size();
        while (pos < json.size() && json[pos] != '"') ++pos;
        if (pos >= json.size()) return "";
        ++pos; // skip opening quote
        size_t strStart = pos;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\') ++pos;
            ++pos;
        }
        std::string val = json.substr(strStart, pos - strStart);
        // Unescape
        std::string unescaped;
        for (size_t i = 0; i < val.size(); ++i) {
            if (val[i] == '\\' && i + 1 < val.size()) {
                switch (val[i + 1]) {
                    case '"': unescaped += '"'; ++i; break;
                    case '\\': unescaped += '\\'; ++i; break;
                    case 'n': unescaped += '\n'; ++i; break;
                    case 'r': unescaped += '\r'; ++i; break;
                    case 't': unescaped += '\t'; ++i; break;
                    default: unescaped += val[i]; break;
                }
            } else {
                unescaped += val[i];
            }
        }
        return unescaped;
    };

    SectionData data;
    data.sessionGoal = extractArr("sessionGoal");
    data.outstandingContext = extractArr("outstandingContext");
    data.filesAndChanges = extractArr("filesAndChanges");
    data.commits = extractArr("commits");
    data.userPreferences = extractArr("userPreferences");
    data.briefTranscript = extractStr("briefTranscript");

    return Napi::String::New(env, formatSummary(data));
}

/*
 * mergeSummaries(previous, fresh, configRaw) -> string
 */
Napi::String MergeSummaries(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string previous = info[0].As<Napi::String>().Utf8Value();
    std::string fresh = info[1].As<Napi::String>().Utf8Value();
    std::string configRaw = info[2].As<Napi::String>().Utf8Value();

    auto config = parseConfig(configRaw);
    return Napi::String::New(env, mergeSummaries(previous, fresh, config));
}

/*
 * searchEntries(rolesRaw, summariesRaw, fullTextsRaw, query) -> JSON string
 *
 * rolesRaw, summariesRaw, fullTextsRaw: \x01-delimited strings
 * query: search query string
 * Returns: JSON array of RecallHit objects
 */
Napi::String SearchEntries(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string rolesRaw = info[0].As<Napi::String>().Utf8Value();
    std::string summariesRaw = info[1].As<Napi::String>().Utf8Value();
    std::string fullTextsRaw = info[2].As<Napi::String>().Utf8Value();
    std::string query = info[3].As<Napi::String>().Utf8Value();

    auto roles = splitOn(rolesRaw, '\x01');
    auto summaries = splitOn(summariesRaw, '\x01');
    auto fullTexts = splitOn(fullTextsRaw, '\x01');

    auto hits = searchEntries(roles, summaries, fullTexts, query);

    std::string json = "[";
    for (size_t i = 0; i < hits.size(); ++i) {
        if (i > 0) json += ",";
        const auto& h = hits[i];
        json += "{\"index\":" + std::to_string(h.index)
              + ",\"role\":\"" + escapeJson(h.role) + "\""
              + ",\"summary\":\"" + escapeJson(h.summary) + "\""
              + ",\"snippet\":\"" + escapeJson(h.snippet) + "\""
              + ",\"matchCount\":" + std::to_string(h.matchCount)
              + ",\"score\":" + std::to_string(h.score) + "}";
    }
    json += "]";

    return Napi::String::New(env, json);
}

/*
 * wrapLongLines(text, maxChars) -> string
 */
Napi::String WrapLongLines(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string text = info[0].As<Napi::String>().Utf8Value();
    int maxChars = info[1].As<Napi::Number>().Int32Value();
    return Napi::String::New(env, wrapLongLines(text, maxChars));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("buildSections",    Napi::Function::New(env, BuildSections));
    exports.Set("formatSummary",    Napi::Function::New(env, FormatSummary));
    exports.Set("mergeSummaries",   Napi::Function::New(env, MergeSummaries));
    exports.Set("searchEntries",    Napi::Function::New(env, SearchEntries));
    exports.Set("wrapLongLines",    Napi::Function::New(env, WrapLongLines));
    return exports;
}

NODE_API_MODULE(addon, Init)
