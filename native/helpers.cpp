#include "helpers.h"
#include <algorithm>
#include <cctype>
#include <sstream>
#include <unordered_map>

// ── sanitize ──────────────────────────────────────────────────
// Normalize line endings, strip ANSI codes and control chars.
std::string sanitize(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    bool afterEscape = false;
    for (size_t i = 0; i < text.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(text[i]);
        // Normalize \r\n and \r to \n
        if (c == '\r') {
            if (i + 1 < text.size() && text[i + 1] == '\n') {
                out += '\n';
                ++i;
            } else {
                out += '\n';
            }
            continue;
        }
        // Strip ANSI escape sequences
        if (c == 0x1b) {
            afterEscape = true;
            continue;
        }
        if (afterEscape) {
            afterEscape = false;
            if (c == '[') {
                // Skip until letter
                while (i + 1 < text.size()) {
                    ++i;
                    unsigned char nc = static_cast<unsigned char>(text[i]);
                    if ((nc >= 'A' && nc <= 'Z') || (nc >= 'a' && nc <= 'z')) break;
                }
            }
            continue;
        }
        // Strip other control chars
        if (c < 0x20 && c != '\n' && c != '\t') continue;
        out += static_cast<char>(c);
    }
    return out;
}

// ── clip ──────────────────────────────────────────────────────
std::string clip(const std::string& text, size_t max) {
    if (text.size() <= max) return text;
    size_t cut = text.rfind(' ', max);
    size_t end = (cut != std::string::npos && cut > max * 3 / 5) ? cut : max;
    return text.substr(0, end);
}

// ── clipSentence ──────────────────────────────────────────────
std::string clipSentence(const std::string& text, size_t max) {
    if (text.size() <= max) return text;
    size_t window = max;
    size_t lastEnd = 0;
    for (size_t i = 0; i < window; ++i) {
        if (text[i] == '.' || text[i] == '!' || text[i] == '?') {
            if (i + 1 >= window || std::isspace(static_cast<unsigned char>(text[i + 1]))) {
                lastEnd = i + 1;
            }
        }
    }
    if (lastEnd >= max / 2) return text.substr(0, lastEnd);
    return clip(text, max);
}

// ── nonEmptyLines ─────────────────────────────────────────────
std::vector<std::string> nonEmptyLines(const std::string& text) {
    std::vector<std::string> lines;
    std::istringstream iss(text);
    std::string line;
    while (std::getline(iss, line)) {
        // Trim
        size_t start = line.find_first_not_of(" \t\r\n");
        if (start == std::string::npos) continue;
        size_t end = line.find_last_not_of(" \t\r\n");
        std::string trimmed = line.substr(start, end - start + 1);
        if (!trimmed.empty()) lines.push_back(trimmed);
    }
    return lines;
}

// ── firstLine ─────────────────────────────────────────────────
std::string firstLine(const std::string& text, size_t max) {
    auto nl = text.find('\n');
    std::string line = (nl == std::string::npos) ? text : text.substr(0, nl);
    return clip(line, max);
}

// ── truncateWords ─────────────────────────────────────────────
// Truncate text to `limit` non-stop words.
static const std::unordered_set<std::string> STOP_WORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "under", "over",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more", "most",
    "other", "some", "such", "no",
    "that", "this", "these", "those", "it", "its",
    "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
    "she", "her", "they", "them", "their", "who", "which", "what",
    "if", "then", "than", "when", "where", "how", "just", "also",
};

std::string truncateWords(const std::string& text, int limit) {
    // Flatten whitespace
    std::string flat;
    flat.reserve(text.size());
    bool lastSpace = true;
    for (char c : text) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            if (!lastSpace) { flat += ' '; lastSpace = true; }
        } else {
            flat += c;
            lastSpace = false;
        }
    }
    // Trim
    while (!flat.empty() && std::isspace(static_cast<unsigned char>(flat.back()))) flat.pop_back();

    int count = 0;
    size_t lastEnd = 0;
    size_t i = 0;
    while (i < flat.size()) {
        // Skip whitespace
        while (i < flat.size() && std::isspace(static_cast<unsigned char>(flat[i]))) ++i;
        if (i >= flat.size()) break;
        // Find word boundary
        size_t wordStart = i;
        while (i < flat.size() && !std::isspace(static_cast<unsigned char>(flat[i]))) ++i;
        std::string word = flat.substr(wordStart, i - wordStart);
        // Check if it's a real word (contains letter or digit)
        bool isWord = false;
        for (char c : word) {
            if (std::isalnum(static_cast<unsigned char>(c))) { isWord = true; break; }
        }
        if (isWord) {
            std::string lower = word;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                          [](unsigned char c){ return std::tolower(c); });
            if (STOP_WORDS.find(lower) == STOP_WORDS.end()) {
                ++count;
                if (count > limit) {
                    return flat.substr(0, lastEnd) + "...(truncated)";
                }
            }
        }
        lastEnd = i;
    }
    return flat;
}

// ── compressBash ──────────────────────────────────────────────
std::string compressBash(const std::string& raw, int cap) {
    // Take first meaningful line
    auto lines = nonEmptyLines(raw);
    std::string cmd = lines.empty() ? raw : lines[0];
    // Strip cd <path> && prefix
    static const std::string cdPrefix = "cd ";
    if (cmd.rfind(cdPrefix, 0) == 0) {
        auto space = cmd.find(' ', 3);
        if (space != std::string::npos) {
            auto endWord = cmd.find_first_of(" \t", space + 1);
            if (endWord != std::string::npos) {
                auto after = cmd.substr(endWord);
                if (after.rfind(" && ", 0) == 0) {
                    cmd = after.substr(4);
                } else if (after.rfind("&&", 0) == 0) {
                    cmd = after.substr(2);
                }
            }
        }
    }
    if (static_cast<int>(cmd.size()) > cap) {
        return cmd.substr(0, cap - 3) + "...";
    }
    return cmd;
}

// ── collapseSkillText ─────────────────────────────────────────
std::string collapseSkillText(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    size_t i = 0;
    while (i < text.size()) {
        // Look for <skill name="..."
        if (text[i] == '<' && i + 6 < text.size() &&
            text.substr(i, 6) == "skill ") {
            // Find name="..."
            auto nameStart = text.find("name=\"", i);
            if (nameStart != std::string::npos && nameStart < i + 50) {
                auto nameValStart = nameStart + 6;
                auto nameValEnd = text.find("\"", nameValStart);
                if (nameValEnd != std::string::npos) {
                    std::string name = text.substr(nameValStart, nameValEnd - nameValStart);
                    out += "[skill: " + name + "]";
                    // Skip to </skill> or end
                    auto closeTag = text.find("</skill>", nameValEnd);
                    i = (closeTag != std::string::npos) ? closeTag + 8 : text.size();
                    continue;
                }
            }
        }
        out += text[i];
        ++i;
    }
    return out;
}

// ── collapseSkillLines ────────────────────────────────────────
std::vector<std::string> collapseSkillLines(const std::vector<std::string>& lines) {
    std::vector<std::string> result;
    std::unordered_set<std::string> seenSkills;
    bool insideSkill = false;
    for (const auto& line : lines) {
        // Check for <skill name="..."
        if (line.find("<skill ") != std::string::npos || line.find("- <skill ") != std::string::npos) {
            auto nameStart = line.find("name=\"");
            if (nameStart != std::string::npos) {
                auto nameValStart = nameStart + 6;
                auto nameValEnd = line.find("\"", nameValStart);
                if (nameValEnd != std::string::npos) {
                    std::string name = line.substr(nameValStart, nameValEnd - nameValStart);
                    insideSkill = true;
                    if (seenSkills.find(name) == seenSkills.end()) {
                        seenSkills.insert(name);
                        result.push_back("[skill: " + name + "]");
                    }
                    continue;
                }
            }
        }
        if (insideSkill) {
            if (line.find("</skill>") != std::string::npos) insideSkill = false;
            continue;
        }
        result.push_back(line);
    }
    return result;
}

// ── stripLeadingBullet ────────────────────────────────────────
std::string stripLeadingBullet(const std::string& line) {
    std::string trimmed = line;
    // Trim leading whitespace
    size_t start = trimmed.find_first_not_of(" \t");
    if (start != std::string::npos) trimmed = trimmed.substr(start);
    // Check for bullet
    if (!trimmed.empty() && (trimmed[0] == '-' || trimmed[0] == '*' || trimmed[0] == '+')) {
        size_t after = trimmed.find_first_not_of(" \t", 1);
        if (after != std::string::npos) trimmed = trimmed.substr(after);
    } else if (!trimmed.empty() && std::isdigit(trimmed[0])) {
        // Numbered list: "1. "
        size_t dot = trimmed.find('.');
        if (dot != std::string::npos) {
            size_t after = trimmed.find_first_not_of(" \t", dot + 1);
            if (after != std::string::npos) trimmed = trimmed.substr(after);
        }
    }
    // Trim trailing whitespace
    size_t end = trimmed.find_last_not_of(" \t\r\n");
    if (end != std::string::npos) trimmed = trimmed.substr(0, end + 1);
    return trimmed;
}

// ── wrapLongLines ─────────────────────────────────────────────
std::string wrapLongLines(const std::string& text, int maxChars) {
    std::string out;
    auto lines = nonEmptyLines(text);
    // Also preserve empty lines for structure
    std::istringstream iss(text);
    std::string line;
    bool first = true;
    while (std::getline(iss, line)) {
        if (!first) out += '\n';
        first = false;
        if (static_cast<int>(line.size()) <= maxChars) {
            out += line;
            continue;
        }
        // Find indent
        std::string indent;
        size_t contentStart = line.find_first_not_of(" \t");
        if (contentStart != std::string::npos) {
            indent = line.substr(0, contentStart);
            // Check for list marker
            if (contentStart + 1 < line.size() && (line[contentStart] == '-' || line[contentStart] == '*')) {
                indent = line.substr(0, contentStart + 1);
                contentStart = line.find_first_not_of(" \t", contentStart + 1);
            }
        }
        std::string contIndent = indent;
        if (static_cast<int>(contIndent.size()) > 8) contIndent = contIndent.substr(0, 8);
        std::string remaining = line;
        std::string prefix = "";
        while (static_cast<int>(prefix.size() + remaining.size()) > maxChars) {
            int available = std::max(20, maxChars - static_cast<int>(prefix.size()));
            size_t splitAt = remaining.rfind(' ', available);
            if (splitAt == std::string::npos || splitAt < available / 2) splitAt = available;
            out += prefix + remaining.substr(0, splitAt);
            // Trim trailing space
            while (!out.empty() && std::isspace(out.back())) out.pop_back();
            out += '\n';
            remaining = remaining.substr(splitAt);
            // Trim leading space
            size_t rs = remaining.find_first_not_of(" \t");
            if (rs != std::string::npos) remaining = remaining.substr(rs);
            prefix = contIndent;
        }
        if (!remaining.empty()) out += prefix + remaining;
    }
    return out;
}

// ── goalSimilarity ────────────────────────────────────────────
// Character trigram Jaccard similarity.
// Extracts all 3-character substrings (trigrams) from each string,
// converts to lowercase, then computes |intersection| / |union|.
double goalSimilarity(const std::string& a, const std::string& b) {
    if (a.size() < 3 || b.size() < 3) return 0.0;

    auto makeTrigrams = [](const std::string& s) -> std::unordered_map<std::string, int> {
        std::unordered_map<std::string, int> trigrams;
        std::string lower = s;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                      [](unsigned char c){ return std::tolower(c); });
        for (size_t i = 0; i + 2 < lower.size(); ++i) {
            std::string tri = lower.substr(i, 3);
            trigrams[tri]++;
        }
        return trigrams;
    };

    auto triA = makeTrigrams(a);
    auto triB = makeTrigrams(b);

    if (triA.empty() || triB.empty()) return 0.0;

    // Compute intersection size (min count for shared trigrams)
    int intersection = 0;
    for (const auto& [key, countA] : triA) {
        auto it = triB.find(key);
        if (it != triB.end()) {
            intersection += std::min(countA, it->second);
        }
    }

    // Union = total trigrams in A + total trigrams in B - intersection
    int totalA = 0, totalB = 0;
    for (const auto& kv : triA) totalA += kv.second;
    for (const auto& kv : triB) totalB += kv.second;
    int unionSize = totalA + totalB - intersection;

    if (unionSize == 0) return 0.0;
    return static_cast<double>(intersection) / unionSize;
}

// ── normalizeError ────────────────────────────────────────────
// Strip variable data from error messages for deduplication.
// Order matters: paths before digits, hex before digits, quotes before general.
std::string normalizeError(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    size_t i = 0;
    while (i < text.size()) {
        // 1. File paths: /path/to/file.ext or C:\path\file or relative/path/file
        // Match: optional drive letter, then path segments with / or \, ending in .ext
        // Also match: path/to/file:line:col patterns
        if ((text[i] == '/' || text[i] == '~') ||
            (i + 1 < text.size() && text[i + 1] == ':')) {
            // Absolute or relative path
            size_t start = i;
            // Consume path characters: alphanumeric, /, \, -, _, ., :, ~, @, space-safe
            while (i < text.size() && text[i] != '\n' && text[i] != '\r') {
                unsigned char c = static_cast<unsigned char>(text[i]);
                if (c == ' ' && i + 1 < text.size() &&
                    (text[i + 1] == ':' || text[i + 1] == '/' || text[i + 1] == '\\')) {
                    ++i; // allow spaces in Windows paths like "C: "
                } else if (std::isalnum(c) || c == '/' || c == '\\' || c == '-' ||
                           c == '_' || c == '.' || c == ':' || c == '~' || c == '@' ||
                           c == '+' || c == '#' || c == '%' || c == '{' || c == '}') {
                    ++i;
                } else {
                    break;
                }
            }
            // Check if we consumed something that looks like a path (has / or \ or .)
            std::string path = text.substr(start, i - start);
            if (path.find('/') != std::string::npos || path.find('\\') != std::string::npos ||
                (path.find('.') != std::string::npos && path.size() > 3)) {
                out += "<FILE>";
                continue;
            }
            // Not a path, output first char and continue
            out += text[start];
            i = start + 1;
            continue;
        }

        // 2. Hex values: 0x... or 0X...
        if ((text[i] == '0' || text[i] == 'O') && i + 1 < text.size() &&
            (text[i + 1] == 'x' || text[i + 1] == 'X')) {
            out += "<HEX>";
            i += 2;
            while (i < text.size() && std::isxdigit(static_cast<unsigned char>(text[i]))) ++i;
            continue;
        }

        // 3. Quoted strings: '...' or "..."
        if (text[i] == '"' || text[i] == '\'') {
            char q = text[i];
            out += "<VAL>";
            ++i; // skip opening quote
            while (i < text.size() && text[i] != q) {
                if (text[i] == '\\') ++i; // skip escaped char
                ++i;
            }
            if (i < text.size()) ++i; // skip closing quote
            continue;
        }

        // 4. Line references: "line 42", "at line 58", "on line 3"
        // Handled via bare digit replacement below, but we want "line <N>" not "line <N>"
        // Actually bare digit replacement handles this naturally

        // 5. Bare digit runs (word-boundary delimited)
        if (std::isdigit(static_cast<unsigned char>(text[i]))) {
            // Check word boundary: prev char is not alphanumeric
            bool wordStart = (i == 0 || !std::isalnum(static_cast<unsigned char>(text[i - 1])));
            size_t digitStart = i;
            while (i < text.size() && std::isdigit(static_cast<unsigned char>(text[i]))) ++i;
            if (wordStart) {
                out += "<N>";
                continue;
            }
            // Part of a larger word (e.g., TS2345) — output as-is
            out += text.substr(digitStart, i - digitStart);
            continue;
        }

        out += text[i];
        ++i;
    }
    return out;
}
