#include "helpers.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <regex>
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

// Simple BM25-lite scoring
static double bm25Score(const std::string& doc, const std::vector<std::string>& terms,
                         int n, double avgDl, const std::unordered_map<std::string, int>& df) {
    double k = 1.2, b = 0.75;
    int dl = 0;
    { std::istringstream iss(doc); std::string w; while (iss >> w) ++dl; }
    if (dl == 0) return 0;
    double score = 0;
    for (const auto& term : terms) {
        // Count occurrences
        int tf = 0;
        std::string lowerDoc = toLower(doc);
        std::string lowerTerm = toLower(term);
        size_t pos = 0;
        while ((pos = lowerDoc.find(lowerTerm, pos)) != std::string::npos) {
            ++tf; pos += lowerTerm.size();
        }
        if (tf == 0) continue;
        auto it = df.find(lowerTerm);
        int docFreq = (it != df.end()) ? it->second : 0;
        double idf = std::log((n - docFreq + 0.5) / (docFreq + 0.5) + 1);
        double tfNorm = (tf * (k + 1)) / (tf + k * (1 - b + b * dl / avgDl));
        score += idf * tfNorm;
    }
    return score;
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
        // Treat the query as a case-insensitive ECMAScript regex. If it does not
        // compile, fall back to a literal case-insensitive substring search.
        std::regex re;
        bool reValid = true;
        try {
            re = std::regex(query, std::regex::icase | std::regex::ECMAScript);
        } catch (const std::regex_error&) {
            reValid = false;
        }

        if (reValid) {
            for (size_t i = 0; i < docs.size(); ++i) {
                std::smatch m;
                bool inFull = std::regex_search(fullTexts[i], m, re);
                if (!inFull && !std::regex_search(roles[i], re)) continue;
                std::string snippet;
                if (inFull) {
                    size_t pos = static_cast<size_t>(m.position(0));
                    size_t len = static_cast<size_t>(m.length(0));
                    size_t start = pos > 60 ? pos - 60 : 0;
                    size_t end = std::min(fullTexts[i].size(), pos + len + 60);
                    snippet = fullTexts[i].substr(start, end - start);
                }
                results.push_back({static_cast<int>(i), roles[i], summaries[i], snippet, 1, 0});
            }
            return results;
        }

        // Invalid regex → literal case-insensitive substring search.
        std::string lowerQuery = toLower(query);
        for (size_t i = 0; i < docs.size(); ++i) {
            if (toLower(docs[i]).find(lowerQuery) != std::string::npos) {
                std::string snippet;
                std::string lowerDoc = toLower(fullTexts[i]);
                size_t pos = lowerDoc.find(lowerQuery);
                if (pos != std::string::npos) {
                    size_t start = std::max(0, static_cast<int>(pos) - 60);
                    size_t end = std::min(fullTexts[i].size(), pos + query.size() + 60);
                    snippet = fullTexts[i].substr(start, end - start);
                }
                results.push_back({static_cast<int>(i), roles[i], summaries[i], snippet, 1, 0});
            }
        }
        return results;
    }

    // Multi-term BM25
    auto terms = splitTerms(query);
    int n = static_cast<int>(docs.size());
    double totalLen = 0;
    for (const auto& d : docs) {
        std::istringstream iss(d); std::string w; while (iss >> w) ++totalLen;
    }
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

    struct ScoredHit {
        int index;
        double score;
        int matchCount;
        std::string snippet;
    };
    std::vector<ScoredHit> scored;

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
                size_t start = std::max(0, static_cast<int>(pos) - 60);
                size_t end = std::min(fullTexts[i].size(), pos + term.size() + 60);
                snippet = fullTexts[i].substr(start, end - start);
                break;
            }
        }
        scored.push_back({static_cast<int>(i), score, mc, snippet});
    }

    // Sort by score desc
    std::sort(scored.begin(), scored.end(),
        [](const ScoredHit& a, const ScoredHit& b){ return a.score > b.score; });

    for (const auto& sh : scored) {
        results.push_back({sh.index, roles[sh.index], summaries[sh.index],
                          sh.snippet, sh.matchCount, sh.score});
    }

    return results;
}
