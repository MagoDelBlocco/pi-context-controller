import { readFileSync } from "fs";
import { searchEntries } from "./native-bridge";

export const PAGE_SIZE = 5;
export const DEFAULT_RECENT = 25;

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: any;
	name?: string;
	cwd?: string;
}

export interface SessionMeta {
	sessionId: string;
	sessionShortId: string;
	sessionName?: string;
	sessionCwd: string;
	isCurrentSession: boolean;
	local: boolean;
}

export interface RenderedEntry {
	index: number;
	role: string;
	summary: string;
	fullText: string;
	timestamp?: number;
	sessionId?: string;
	sessionShortId?: string;
	sessionName?: string;
	isCurrentSession?: boolean;
	local?: boolean;
}

export interface RecallHit {
	index: number;
	role: string;
	summary: string;
	snippet: string;
	matchCount: number;
	score: number;
	timestamp?: number;
	sessionId?: string;
	sessionShortId?: string;
	sessionName?: string;
	isCurrentSession?: boolean;
	local?: boolean;
}

export type RecallScope = "lineage" | "all";
export type RecallHistoryScope = "local" | "global";

/** The same session-wide message numbering used by recall's #N entries. */
export const loadMessageIndices = (sessionFile: string): Map<string, number> => {
	const byId = new Map<string, number>();
	let index = 0;
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry: SessionEntry = JSON.parse(line);
			if (entry.type !== "message" || !entry.message) continue;
			if (entry.id) byId.set(entry.id, index);
			index++;
		} catch {
			/* skip malformed entries, as recall does */
		}
	}
	return byId;
};

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

const timestampOf = (msg: any, entry: SessionEntry): number | undefined => {
	if (typeof msg.timestamp === "number") return msg.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
};

const renderMessage = (
	msg: any,
	index: number,
	entry: SessionEntry,
	meta?: SessionMeta,
): RenderedEntry => {
	const common = {
		index,
		timestamp: timestampOf(msg, entry),
		sessionId: meta?.sessionId,
		sessionShortId: meta?.sessionShortId,
		sessionName: meta?.sessionName,
		isCurrentSession: meta?.isCurrentSession,
		local: meta?.local,
	};
	if (msg.role === "user") {
		return {
			...common,
			role: "user",
			summary: clip(textOf(msg.content), 300),
			fullText: textOf(msg.content),
		};
	}
	if (msg.role === "toolResult") {
		const prefix = msg.isError ? "ERROR " : "";
		return {
			...common,
			role: "tool_result",
			summary: `${prefix}[${msg.toolName}] ${clip(textOf(msg.content), 200)}`,
			fullText: textOf(msg.content),
		};
	}
	if (msg.role === "bashExecution") {
		const cmd = msg.command ?? "";
		const out = msg.output ?? "";
		return {
			...common,
			role: "bash",
			summary: clip(`$ ${cmd}\n${out}`, 300),
			fullText: `$ ${cmd}\n${out}`,
		};
	}
	if (msg.role === "system") {
		// Labelled system, not assistant: recall results must show where the text came from.
		return {
			...common,
			role: "system",
			summary: clip(textOf(msg.content), 300),
			fullText: textOf(msg.content),
		};
	}
	const text = textOf(msg.content);
	return { ...common, role: "assistant", summary: clip(text, 300), fullText: text };
};

export const readSessionEntries = (sessionFile: string): SessionEntry[] => {
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
	return entries;
};

export const renderSessionEntries = (
	entries: SessionEntry[],
	allowedEntryIds?: Set<string>,
	meta?: SessionMeta,
): RenderedEntry[] => {
	const rendered: RenderedEntry[] = [];
	let messageIndex = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		if (!allowedEntryIds || allowedEntryIds.has(e.id)) {
			rendered.push(renderMessage(e.message, messageIndex, e, meta));
		}
		messageIndex++;
	}
	return rendered;
};

export const loadAllMessages = (
	sessionFile: string,
	allowedEntryIds?: Set<string>,
	meta?: SessionMeta,
): RenderedEntry[] => renderSessionEntries(readSessionEntries(sessionFile), allowedEntryIds, meta);

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
	return hits.map((h) => {
		const entry = entries[h.index];
		return {
			...h,
			index: entry?.index ?? h.index,
			timestamp: entry?.timestamp,
			sessionId: entry?.sessionId,
			sessionShortId: entry?.sessionShortId,
			sessionName: entry?.sessionName,
			isCurrentSession: entry?.isCurrentSession,
			local: entry?.local,
		};
	});
};

export const formatRecallOutput = (
	hits: Array<{
		index: number;
		role: string;
		summary: string;
		snippet: string;
		sessionShortId?: string;
		isCurrentSession?: boolean;
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
		const ref = h.isCurrentSession || !h.sessionShortId
			? `#${h.index}`
			: `#${h.sessionShortId}:${h.index}`;
		return `${ref} [${h.role}] ${body}`;
	});
	return `${header}\n\n${lines.join("\n\n")}`;
};

export const scopePrefix = (scope: RecallScope): string =>
	scope === "all" ? "Scope: all\n\n" : "";

export const historyPrefix = (
	historyScope: RecallHistoryScope,
	usedSessions: number,
	availableSessions: number,
	localFirst = false,
): string => {
	const count = availableSessions > usedSessions
		? `${usedSessions} of ${availableSessions}`
		: `${usedSessions}`;
	const label = count === "1" ? "session" : "sessions";
	return `History: ${historyScope} (${count} ${label}${localFirst ? ", local first" : ""})\n\n`;
};

export interface SearchPage {
	text: string;
	total: number;
	page: number;
	totalPages: number;
}

export interface SearchPageOptions {
	maxHits?: number;
	localFirst?: boolean;
}

const sortLocalFirst = (hits: RecallHit[]): RecallHit[] => {
	return [...hits].sort((a, b) => {
		const aLocal = a.local ? 1 : 0;
		const bLocal = b.local ? 1 : 0;
		if (aLocal !== bLocal) return bLocal - aLocal;
		if (a.score !== b.score) return b.score - a.score;
		if ((b.timestamp ?? 0) !== (a.timestamp ?? 0)) {
			return (b.timestamp ?? 0) - (a.timestamp ?? 0);
		}
		return a.index - b.index;
	});
};

/**
 * One page of search results with the header both callers show. The tool and the
 * slash command differ only in their "next page" hint, which they append themselves.
 */
export const searchPage = (
	entries: RenderedEntry[],
	query: string,
	page: number,
	scope: RecallScope,
	options?: SearchPageOptions,
): SearchPage => {
	let allResults = search(entries, query);
	if (options?.localFirst) allResults = sortLocalFirst(allResults);
	const maxHits = options?.maxHits;
	if (typeof maxHits === "number" && maxHits > 0 && allResults.length > maxHits) {
		allResults = allResults.slice(0, maxHits);
	}
	const totalPages = Math.max(1, Math.ceil(allResults.length / PAGE_SIZE));
	const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
	const start = (current - 1) * PAGE_SIZE;
	const pageResults = allResults.slice(start, start + PAGE_SIZE);
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

export type ExpandSpec = number | string;

type ParsedExpandSpec = { key?: string; index: number; raw: string };

const parseExpandSpec = (spec: ExpandSpec): ParsedExpandSpec => {
	const raw = String(spec).trim();
	if (typeof spec === "number") return { index: spec, raw };
	if (!raw) return { index: Number.NaN, raw };
	const cleaned = raw.startsWith("#") ? raw.slice(1) : raw;
	const match = cleaned.match(/^(.*?)[:/](\d+)$/);
	if (match) {
		const key = match[1].trim();
		const index = Number(match[2]);
		if (!Number.isFinite(index)) return { index: Number.NaN, raw };
		return { key: key || undefined, index, raw };
	}
	const numeric = Number(cleaned);
	if (Number.isFinite(numeric)) return { index: numeric, raw };
	return { index: Number.NaN, raw };
};

const entryRef = (entry: RenderedEntry): string =>
	entry.isCurrentSession || !entry.sessionShortId
		? `#${entry.index}`
		: `#${entry.sessionShortId}:${entry.index}`;

/**
 * Full untruncated text for the requested indices, or null when none were asked
 * for. Numeric indices resolve within the current session; strings such as
 * "01a1f107:12" resolve a session-qualified entry from another session.
 */
export const renderExpanded = (
	entries: RenderedEntry[],
	indices: Iterable<ExpandSpec>,
	currentSessionId?: string,
): string | null => {
	const specs = [...indices].map(parseExpandSpec);
	if (specs.length === 0) return null;

	const seen = new Set<string>();
	const wanted = specs.filter((spec) => {
		const dedupeKey = Number.isNaN(spec.index)
			? `invalid:${spec.raw}`
			: `${spec.key ?? ""}:${spec.index}`;
		if (seen.has(dedupeKey)) return false;
		seen.add(dedupeKey);
		return true;
	});

	const found: RenderedEntry[] = [];
	const missing: string[] = [];
	for (const spec of wanted) {
		const match = entries.find((entry) => {
			if (entry.index !== spec.index) return false;
			if (spec.key) {
				return entry.sessionShortId === spec.key ||
					entry.sessionId === spec.key ||
					entry.sessionName === spec.key;
			}
			if (currentSessionId) {
				return entry.sessionId === currentSessionId ||
					entry.isCurrentSession === true;
			}
			return true;
		});
		if (match) found.push(match);
		else missing.push(spec.raw);
	}

	if (found.length === 0) return `No entries indexed ${missing.join(", ")}.`;
	const header = `Expanded ${found.length} ${found.length === 1 ? "entry" : "entries"}:`;
	const body = found
		.map((entry) => `${entryRef(entry)} [${entry.role}] ${entry.fullText}`)
		.join("\n\n");
	const missingNote =
		missing.length > 0 ? `\n\n(no entry indexed ${missing.join(", ")})` : "";
	return `${header}\n\n${body}${missingNote}`;
};

/** Recent-tail view, used when neither a query nor indices are given. */
export const renderRecent = (entries: RenderedEntry[]): string => {
	const ordered = entries.some((entry) => entry.timestamp !== undefined)
		? [...entries].sort(
			(a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
		)
		: entries;
	const hits = ordered.slice(-DEFAULT_RECENT).map((e) => ({
		index: e.index,
		role: e.role,
		summary: e.summary,
		snippet: "",
		sessionShortId: e.sessionShortId,
		isCurrentSession: e.isCurrentSession,
	}));
	return formatRecallOutput(hits);
};
