import { type SessionCandidate } from "./recall-discovery";
import { sameCwd } from "./session-paths";
import {
	readSessionEntries,
	renderSessionEntries,
	type RenderedEntry,
	type RecallScope,
	type SessionEntry,
	type SessionMeta,
} from "./recall-shared";

export interface RecallSessionInfo {
	sessionId: string;
	sessionShortId: string;
	sessionName?: string;
	cwd: string;
	local: boolean;
	isCurrentSession: boolean;
	path?: string;
	modified: number;
	messageCount: number;
}

export interface LoadedCandidate {
	entries: RenderedEntry[];
	info: RecallSessionInfo;
}

export const shortSessionId = (id: string): string =>
	id.slice(0, 8) || "unknown";

const activeBranchIds = (entries: SessionEntry[]): Set<string> => {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type !== "session") byId.set(entry.id, entry);
	}
	const ids = new Set<string>();
	let current = entries[entries.length - 1];
	while (current && current.type !== "session") {
		ids.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return ids;
};

const latestSessionName = (entries: SessionEntry[]): string | undefined =>
	entries.findLast(
		(entry) => entry.type === "session_info" && typeof entry.name === "string",
	)?.name;

export const loadSessionCandidate = (
	candidate: SessionCandidate,
	currentCwd: string,
	branchScope: RecallScope,
): LoadedCandidate | null => {
	let parsedEntries: SessionEntry[];
	try {
		parsedEntries = readSessionEntries(candidate.path);
	} catch {
		return null;
	}
	const header =
		parsedEntries.find((entry) => entry.type === "session") ??
		candidate.header;
	const sessionId = header.id;
	if (!sessionId) return null;
	const cwd = header.cwd ?? "";
	const meta: SessionMeta = {
		sessionId,
		sessionShortId: shortSessionId(sessionId),
		sessionName: latestSessionName(parsedEntries),
		sessionCwd: cwd,
		isCurrentSession: false,
		local: sameCwd(cwd, currentCwd),
	};
	const allowed =
		branchScope === "lineage" ? activeBranchIds(parsedEntries) : undefined;
	const entries = renderSessionEntries(parsedEntries, allowed, meta);
	return {
		entries,
		info: {
			sessionId,
			sessionShortId: meta.sessionShortId,
			sessionName: meta.sessionName,
			cwd,
			local: meta.local,
			isCurrentSession: false,
			path: candidate.path,
			modified: candidate.modified,
			messageCount: entries.length,
		},
	};
};
