#include <napi.h>
#include <cctype>
#include <string>
#include <vector>
#include "helpers.h"

// Forward declarations from compaction.cpp
// (buildSections is declared in helpers.h with its full 3-arg signature.)
extern std::string formatSummary(const SectionData& data);
extern std::string mergeSummaries(const std::string& previous, const std::string& fresh, const CompactionConfig& config);

// Forward declarations from recall.cpp
extern std::vector<RecallHit> searchEntries(
    const std::vector<std::string>& roles,
    const std::vector<std::string>& summaries,
    const std::vector<std::string>& fullTexts,
    const std::string& query);

// ── JSON escape helper ────────────────────────────────────────
// The inverse operation is jsonUnescape in helpers.cpp, shared with the
// tool-argument reader in compaction.cpp so both readers agree on escape semantics.
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

// ── Input parsing ──────────────────────────────────────────────
// Message content is passed as N-API arrays and objects. It may contain any
// control character, so a delimiter-based wire format is not safe here.

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

static std::vector<NormalizedBlock> parseBlocks(const Napi::Array& input) {
    std::vector<NormalizedBlock> blocks;
    blocks.reserve(input.Length());
    for (uint32_t i = 0; i < input.Length(); ++i) {
        auto value = input.Get(i);
        if (!value.IsObject()) continue;
        auto obj = value.As<Napi::Object>();
        auto stringField = [&](const char* key) -> std::string {
            auto field = obj.Get(key);
            return field.IsString() ? field.As<Napi::String>().Utf8Value() : "";
        };
        auto numberField = [&](const char* key, int fallback) -> int {
            auto field = obj.Get(key);
            return field.IsNumber() ? field.As<Napi::Number>().Int32Value() : fallback;
        };
        NormalizedBlock b;
        b.kind = blockKindFromStr(stringField("kind"));
        b.text = stringField("text");
        b.name = stringField("name");
        b.argsJson = stringField("argsJson");
        b.isError = obj.Get("isError").ToBoolean().Value();
        b.command = stringField("command");
        b.output = stringField("output");
        b.exitCode = numberField("exitCode", -1);
        b.sourceIndex = numberField("sourceIndex", -1);
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
 * buildSections(blocks, configRaw) -> JSON string
 *
 * blocks: array of normalized block objects
 * configRaw: delimited string (see parseConfig)
 * Returns: JSON string of SectionData
 */
Napi::String BuildSections(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto blocksInput = info[0].As<Napi::Array>();
    std::string configRaw = info[1].As<Napi::String>().Utf8Value();

    auto blocks = parseBlocks(blocksInput);
    auto config = parseConfig(configRaw);

    SectionData data = buildSections(blocks, config);

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
    addStrArr("currentDirection", data.currentDirection);
    addStrArr("sessionGoal", data.sessionGoal);
    addStrArr("decisions", data.decisions);
    addStrArr("verifiedOutcomes", data.verifiedOutcomes);
    addStrArr("nextStep", data.nextStep);
    addStrArr("outstandingContext", data.outstandingContext);
    addStrArr("filesAndChanges", data.filesAndChanges);
    addStrArr("commits", data.commits);
    addStrArr("userPreferences", data.userPreferences);
    json += "\"briefTranscript\":\"" + escapeJson(data.briefTranscript) + "\"";
    json += ",\"metrics\":{\"goalCoverage\":" + std::to_string(data.metrics.goalCoverage)
         + ",\"errorResolutionRate\":" + std::to_string(data.metrics.errorResolutionRate)
         + ",\"toolSuccessRate\":" + std::to_string(data.metrics.toolSuccessRate)
         + ",\"compressionRatio\":" + std::to_string(data.metrics.compressionRatio)
         + ",\"rawChars\":" + std::to_string(data.metrics.rawChars)
         + ",\"briefChars\":" + std::to_string(data.metrics.briefChars) + "}";
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
            arr.push_back(jsonUnescape(val));
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
        return jsonUnescape(val);
    };

    // Metrics travel with the sections: read them back so a JSON round trip
    // through this function does not silently zero them.
    auto extractNum = [&](const char* key) -> double {
        std::string search = std::string("\"") + key + "\":";
        size_t pos = json.find(search);
        if (pos == std::string::npos) return 0.0;
        pos += search.size();
        size_t end = pos;
        while (end < json.size()) {
            char c = json[end];
            bool numeric = std::isdigit(static_cast<unsigned char>(c)) ||
                           c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E';
            if (!numeric) break;
            ++end;
        }
        if (end == pos) return 0.0;
        try { return std::stod(json.substr(pos, end - pos)); } catch (...) { return 0.0; }
    };

    SectionData data;
    data.currentDirection = extractArr("currentDirection");
    data.sessionGoal = extractArr("sessionGoal");
    data.decisions = extractArr("decisions");
    data.verifiedOutcomes = extractArr("verifiedOutcomes");
    data.nextStep = extractArr("nextStep");
    data.outstandingContext = extractArr("outstandingContext");
    data.filesAndChanges = extractArr("filesAndChanges");
    data.commits = extractArr("commits");
    data.userPreferences = extractArr("userPreferences");
    data.briefTranscript = extractStr("briefTranscript");
    data.metrics.goalCoverage = extractNum("goalCoverage");
    data.metrics.errorResolutionRate = extractNum("errorResolutionRate");
    data.metrics.toolSuccessRate = extractNum("toolSuccessRate");
    data.metrics.compressionRatio = extractNum("compressionRatio");
    data.metrics.rawChars = static_cast<long long>(extractNum("rawChars"));
    data.metrics.briefChars = static_cast<long long>(extractNum("briefChars"));

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
 * searchEntries(roles, summaries, fullTexts, query) -> JSON string
 *
 * roles, summaries, fullTexts: string arrays
 * query: search query string
 * Returns: JSON array of RecallHit objects
 */
Napi::String SearchEntries(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto readStrings = [](const Napi::Value& value) {
        std::vector<std::string> out;
        auto array = value.As<Napi::Array>();
        out.reserve(array.Length());
        for (uint32_t i = 0; i < array.Length(); ++i)
            out.push_back(array.Get(i).As<Napi::String>().Utf8Value());
        return out;
    };
    auto roles = readStrings(info[0]);
    auto summaries = readStrings(info[1]);
    auto fullTexts = readStrings(info[2]);
    std::string query = info[3].As<Napi::String>().Utf8Value();

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
