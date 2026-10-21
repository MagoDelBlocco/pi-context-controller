import { readFileSync } from "fs";
import { searchEntries } from "./native-bridge";

export const PAGE_SIZE = 5;
export const DEFAULT_RECENT = 25;

interface SessionEntry {
	type: string;
	id: string;
	message?: any;
}

export interface RenderedEntry {
	index: number;
	role: string;
	summary: string;
	fullText: string;
}

export interface RecallHit {
	index: number;
	role: string;
	summary: string;
	snippet: string;
	matchCount: number;
	score: number;
}

const textOf = (content: unknown): string => {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text ?? "")
			.join("\n");
	}
	return "";
};

const clip = (text: string, max: number): string => {
	if (text.length <= max) return text;
	const cut = text.lastIndexOf(" ", max);
	const end = cut > max * 0.6 ? cut : max;
	return text.slice(0, end);
};

const renderMessage = (msg: any, index: number): RenderedEntry => {
	if (msg.role === "user") {
		return {
			index,
			role: "user",
			summary: clip(textOf(msg.content), 300),
			fullText: textOf(msg.content),
		};
	}
	if (msg.role === "toolResult") {
		const prefix = msg.isError ? "ERROR " : "";
		return {
			index,
			role: "tool_result",
			summary: `${prefix}[${msg.toolName}] ${clip(textOf(msg.content), 200)}`,
			fullText: textOf(msg.content),
		};
	}
	if (msg.role === "bashExecution") {
		const cmd = msg.command ?? "";
		const out = msg.output ?? "";
		return {
			index,
			role: "bash",
			summary: clip(`$ ${cmd}\n${out}`, 300),
			fullText: `$ ${cmd}\n${out}`,
		};
	}
	if (msg.role === "system") {
		// Labelled system, not assistant: recall results must show where the text came from.
		return {
			index,
			role: "system",
			summary: clip(textOf(msg.content), 300),
			fullText: textOf(msg.content),
		};
	}
	const text = textOf(msg.content);
	return { index, role: "assistant", summary: clip(text, 300), fullText: text };
};

export const loadAllMessages = (
	sessionFile: string,
	allowedEntryIds?: Set<string>,
): RenderedEntry[] => {
	const content = readFileSync(sessionFile, "utf-8");
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* skip malformed */
		}
	}
	const rendered: RenderedEntry[] = [];
	let messageIndex = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
		if (allowed) rendered.push(renderMessage(e.message, messageIndex));
		messageIndex++;
	}
	return rendered;
};

export const getActiveLineageEntryIds = (sessionManager: any): Set<string> => {
	try {
		const branch = sessionManager.getBranch?.() ?? [];
		if (branch.length > 0) {
			return new Set(
				branch
					.map((e: any) => e.id)
					.filter((id: any): id is string => Boolean(id)),
			);
		}
	} catch {
		/* skip */
	}
	try {
		const all = sessionManager.getEntries?.() ?? [];
		return new Set(
			all.map((e: any) => e.id).filter((id: any): id is string => Boolean(id)),
		);
	} catch {
		/* skip */
	}
	return new Set();
};

/**
 * Run a search over rendered entries. The native search returns positions into
 * the entries array; we map them back to each entry's stable message index so
 * the `#N` shown to the caller matches what `expand:[N]` and the recent view use.
 */
export const search = (entries: RenderedEntry[], query: string): RecallHit[] => {
	const roles = entries.map((e) => e.role);
	const summaries = entries.map((e) => e.summary);
	const fullTexts = entries.map((e) => e.fullText);
	const hits = searchEntries(roles, summaries, fullTexts, query);
	return hits.map((h) => ({
		...h,
		index: entries[h.index]?.index ?? h.index,
	}));
};

export const formatRecallOutput = (
	hits: Array<{
		index: number;
		role: string;
		summary: string;
		snippet: string;
	}>,
	query?: string,
	headerOverride?: string,
): string => {
	if (hits.length === 0) {
		return query
			? `No matches for "${query}" in session history.`
			: "No entries in session history.";
	}
	const header = headerOverride
		? `${headerOverride} for "${query}":`
		: query
			? `Found ${hits.length} matches for "${query}":`
			: `Session history (${hits.length} entries):`;
	const lines = hits.map((h) => {
		const body = query && h.snippet ? h.snippet : h.summary;
		return `#${h.index} [${h.role}] ${body}`;
	});
	return `${header}\n\n${lines.join("\n\n")}`;
};

export type RecallScope = "lineage" | "all";

export const scopePrefix = (scope: RecallScope): string =>
	scope === "all" ? "Scope: all\n\n" : "";

export interface SearchPage {
	text: string;
	total: number;
	page: number;
	totalPages: number;
}

/**
 * One page of search results with the header both callers show. The tool and the
 * slash command differ only in their "next page" hint, which they append themselves.
 */
export const searchPage = (
	entries: RenderedEntry[],
	query: string,
	page: number,
	scope: RecallScope,
): SearchPage => {
	const allResults = search(entries, query);
	const current = Math.max(1, Math.floor(page) || 1);
	const start = (current - 1) * PAGE_SIZE;
	const pageResults = allResults.slice(start, start + PAGE_SIZE);
	const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
	const scopeSuffix = scope === "all" ? " (scope: all)" : "";
	const header =
		totalPages > 1
			? `Page ${current}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
			: `${allResults.length} matches${scopeSuffix}`;
	return {
		text: formatRecallOutput(pageResults, query, header),
		total: allResults.length,
		page: current,
		totalPages,
	};
};

/**
 * Full untruncated text for the requested indices, or null when none were asked
 * for. Unknown indices are named instead of silently dropped.
 */
export const renderExpanded = (
	entries: RenderedEntry[],
	indices: Iterable<number>,
): string | null => {
	const wanted = [...new Set(indices)];
	if (wanted.length === 0) return null;
	const byIndex = new Map(entries.map((m) => [m.index, m]));
	const found: RenderedEntry[] = [];
	const missing: number[] = [];
	for (const i of wanted) {
		const e = byIndex.get(i);
		if (e) found.push(e);
		else missing.push(i);
	}
	if (found.length === 0) return `No entries indexed ${missing.join(", ")}.`;
	const header = `Expanded ${found.length} ${found.length === 1 ? "entry" : "entries"}:`;
	const body = found
		.map((e) => `#${e.index} [${e.role}] ${e.fullText}`)
		.join("\n\n");
	const missingNote =
		missing.length > 0 ? `\n\n(no entry indexed ${missing.join(", ")})` : "";
	return `${header}\n\n${body}${missingNote}`;
};

/** Recent-tail view, used when neither a query nor indices are given. */
export const renderRecent = (entries: RenderedEntry[]): string => {
	const hits = entries.slice(-DEFAULT_RECENT).map((e) => ({
		index: e.index,
		role: e.role,
		summary: e.summary,
		snippet: "",
	}));
	return formatRecallOutput(hits);
};
