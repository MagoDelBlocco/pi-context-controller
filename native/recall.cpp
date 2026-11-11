#include "helpers.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

// ── Recall search ─────────────────────────────────────────────

static bool looksLikeRegex(const std::string& query) {
    for (char c : query) {
        if (c == '|' || c == '*' || c == '+' || c == '?' || c == '{' ||
            c == '}' || c == '(' || c == ')' || c == '[' || c == ']' ||
            c == '\\' || c == '^' || c == '$' || c == '.') {
            return true;
        }
    }
    return false;
}

static std::string toLower(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                  [](unsigned char c){ return std::tolower(c); });
    return out;
}

static bool containsIgnoreCase(const std::string& haystack, const std::string& needle) {
    return toLower(haystack).find(toLower(needle)) != std::string::npos;
}

static const std::unordered_set<std::string> STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "of", "in", "to", "for",
    "with", "on", "at", "from", "by", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "about", "it", "its", "that",
    "this", "what", "which", "who", "whom", "these", "those",
};

static std::vector<std::string> splitTerms(const std::string& query) {
    std::vector<std::string> terms;
    std::istringstream iss(query);
    std::string term;
    while (iss >> term) {
        std::string lower = toLower(term);
        if (STOPWORDS.find(lower) == STOPWORDS.end() && term.size() > 1) {
            terms.push_back(term);
        }
    }
    if (terms.empty()) {
        std::istringstream iss2(query);
        std::string t;
        while (iss2 >> t) terms.push_back(t);
    }
    return terms;
}

static int countTermMatches(const std::string& text, const std::vector<std::string>& terms) {
    int count = 0;
    for (const auto& term : terms) {
        if (containsIgnoreCase(text, term)) ++count;
    }
    return count;
}

static int wordCount(const std::string& doc) {
    std::istringstream iss(doc);
    std::string w;
    int n = 0;
    while (iss >> w) ++n;
    return n;
}

// BM25 term-frequency normalization (k1 = 1.2, b = 0.75).
static double bm25TfNorm(int tf, int dl, double avgDl) {
    const double k = 1.2, b = 0.75;
    if (tf <= 0 || dl <= 0 || avgDl <= 0) return 0.0;
    return (tf * (k + 1)) / (tf + k * (1 - b + b * dl / avgDl));
}

// Simple BM25-lite scoring
static double bm25Score(const std::string& doc, const std::vector<std::string>& terms,
                         int n, double avgDl, const std::unordered_map<std::string, int>& df) {
    int dl = wordCount(doc);
    if (dl == 0) return 0;
    double score = 0;
    std::string lowerDoc = toLower(doc);
    for (const auto& term : terms) {
        // Count occurrences
        int tf = 0;
        std::string lowerTerm = toLower(term);
        size_t pos = 0;
        while ((pos = lowerDoc.find(lowerTerm, pos)) != std::string::npos) {
            ++tf; pos += lowerTerm.size();
        }
        if (tf == 0) continue;
        auto it = df.find(lowerTerm);
        int docFreq = (it != df.end()) ? it->second : 0;
        double idf = std::log((n - docFreq + 0.5) / (docFreq + 0.5) + 1);
        score += idf * bm25TfNorm(tf, dl, avgDl);
    }
    return score;
}

// Window around the first match, for the snippet shown to the caller.
static std::string makeSnippet(const std::string& text, size_t matchStart, size_t matchLen) {
    size_t start = matchStart > 60 ? matchStart - 60 : 0;
    size_t end = std::min(text.size(), matchStart + matchLen + 60);
    return text.substr(start, end - start);
}

struct SafeAlternative {
    std::string before;
    std::string after;
    bool wildcard = false;
};

// A linear-time subset of the advertised patterns: literal alternatives and
// one .* between nonempty literal spans. Other regex syntax is searched literally.
static bool parseSafePattern(const std::string& query,
                             std::vector<SafeAlternative>& alternatives) {
    size_t start = 0;
    while (start <= query.size()) {
        size_t end = query.find('|', start);
        std::string part = query.substr(start, end == std::string::npos ? end : end - start);
        if (part.empty() || alternatives.size() >= 16) return false;
        size_t wildcard = part.find(".*");
        if (wildcard != std::string::npos) {
            if (part.find(".*", wildcard + 2) != std::string::npos ||
                wildcard == 0 || wildcard + 2 == part.size()) return false;
        }
        for (size_t i = 0; i < part.size(); ++i) {
            char c = part[i];
            if (c == '.' && i == wildcard) { ++i; continue; }
            if (c == '.' || c == '*' || c == '+' || c == '?' || c == '{' ||
                c == '}' || c == '(' || c == ')' || c == '[' || c == ']' ||
                c == '\\' || c == '^' || c == '$') return false;
        }
        alternatives.push_back({toLower(part.substr(0, wildcard)),
                                wildcard == std::string::npos ? "" : toLower(part.substr(wildcard + 2)),
                                wildcard != std::string::npos});
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return !alternatives.empty();
}

struct PatternMatch {
    int count = 0;
    size_t first = std::string::npos;
    size_t length = 0;
};

static PatternMatch matchSafePattern(const std::string& text,
                                     const std::vector<SafeAlternative>& alternatives) {
    std::string lower = toLower(text);
    PatternMatch result;
    for (const auto& alt : alternatives) {
        size_t cursor = 0;
        while (cursor < lower.size() && result.count < 1000) {
            size_t pos = lower.find(alt.before, cursor);
            if (pos == std::string::npos) break;
            size_t end = pos + alt.before.size();
            if (alt.wildcard) {
                size_t suffix = lower.find(alt.after, end);
                if (suffix == std::string::npos) break;
                end = suffix + alt.after.size();
            }
            ++result.count;
            if (pos < result.first) {
                result.first = pos;
                result.length = std::min(end - pos, size_t(80));
            }
            cursor = end;
        }
    }
    return result;
}

struct ScoredEntry {
    int index;
    double score;
    int matchCount;
    std::string snippet;
};

// Ranks per-document match counts with the same BM25 scale the multi-term path
// uses, so a regex query returns a real ranking signal instead of score 0.
// Ties break on document order, which keeps output deterministic.
static std::vector<RecallHit> rankSinglePattern(
    const std::vector<std::string>& roles,
    const std::vector<std::string>& summaries,
    const std::vector<std::string>& docs,
    const std::vector<int>& tf,
    const std::vector<std::string>& snippets)
{
    const int n = static_cast<int>(docs.size());
    int df = 0;
    double totalLen = 0;
    for (size_t i = 0; i < docs.size(); ++i) {
        if (tf[i] > 0) ++df;
        totalLen += wordCount(docs[i]);
    }
    double avgDl = totalLen / std::max(n, 1);
    double idf = std::log((n - df + 0.5) / (df + 0.5) + 1);

    std::vector<ScoredEntry> scored;
    for (size_t i = 0; i < docs.size(); ++i) {
        if (tf[i] <= 0) continue;
        scored.push_back({static_cast<int>(i),
                         idf * bm25TfNorm(tf[i], wordCount(docs[i]), avgDl),
                         tf[i], snippets[i]});
    }
    std::sort(scored.begin(), scored.end(), [](const ScoredEntry& a, const ScoredEntry& b) {
        if (a.score != b.score) return a.score > b.score;
        return a.index < b.index;
    });

    std::vector<RecallHit> results;
    for (const auto& s : scored) {
        results.push_back({s.index, roles[s.index], summaries[s.index],
                          s.snippet, s.matchCount, s.score});
    }
    return results;
}

std::vector<RecallHit> searchEntries(
    const std::vector<std::string>& roles,
    const std::vector<std::string>& summaries,
    const std::vector<std::string>& fullTexts,
    const std::string& query)
{
    std::vector<RecallHit> results;
    if (query.empty()) {
        for (int i = 0; i < static_cast<int>(roles.size()); ++i) {
            results.push_back({i, roles[i], summaries[i], "", 0, 0});
        }
        return results;
    }

    // Build docs
    std::vector<std::string> docs;
    for (size_t i = 0; i < roles.size(); ++i) {
        docs.push_back(roles[i] + " " + fullTexts[i]);
    }

    if (looksLikeRegex(query)) {
        std::vector<SafeAlternative> alternatives;
        bool safePattern = parseSafePattern(query, alternatives);
        if (!safePattern) alternatives = {{toLower(query), "", false}};

        std::vector<int> tf(docs.size(), 0);
        std::vector<std::string> snippets(docs.size());

        for (size_t i = 0; i < docs.size(); ++i) {
            tf[i] = matchSafePattern(docs[i], alternatives).count;
            auto bodyMatch = matchSafePattern(fullTexts[i], alternatives);
            if (bodyMatch.first != std::string::npos)
                snippets[i] = makeSnippet(fullTexts[i], bodyMatch.first, bodyMatch.length);
        }
        return rankSinglePattern(roles, summaries, docs, tf, snippets);
    }

    // Multi-term BM25
    auto terms = splitTerms(query);
    int n = static_cast<int>(docs.size());
    double totalLen = 0;
    for (const auto& d : docs) totalLen += wordCount(d);
    double avgDl = totalLen / std::max(n, 1);

    std::unordered_map<std::string, int> df;
    for (const auto& term : terms) {
        std::string lowerTerm = toLower(term);
        int count = 0;
        for (const auto& doc : docs) {
            if (toLower(doc).find(lowerTerm) != std::string::npos) ++count;
        }
        df[lowerTerm] = count;
    }

    std::vector<ScoredEntry> scored;

    for (size_t i = 0; i < docs.size(); ++i) {
        int mc = countTermMatches(docs[i], terms);
        if (mc == 0) continue;
        double score = bm25Score(docs[i], terms, n, avgDl, df);
        // Snippet: find first matching term
        std::string snippet;
        for (const auto& term : terms) {
            std::string lowerTerm = toLower(term);
            size_t pos = toLower(fullTexts[i]).find(lowerTerm);
            if (pos != std::string::npos) {
                snippet = makeSnippet(fullTexts[i], pos, term.size());
                break;
            }
        }
        scored.push_back({static_cast<int>(i), score, mc, snippet});
    }

    // Sort by score desc, ties by document order
    std::sort(scored.begin(), scored.end(), [](const ScoredEntry& a, const ScoredEntry& b) {
        if (a.score != b.score) return a.score > b.score;
        return a.index < b.index;
    });

    for (const auto& sh : scored) {
        results.push_back({sh.index, roles[sh.index], summaries[sh.index],
                          sh.snippet, sh.matchCount, sh.score});
    }

    return results;
}
