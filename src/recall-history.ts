import {
	collectSessionCandidates,
	selectSessionCandidates,
	type DiscoveryOptions,
} from "./recall-discovery";
import {
	loadSessionCandidate,
	shortSessionId,
	type RecallSessionInfo,
} from "./recall-session";
import {
	renderSessionEntries,
	type RenderedEntry,
	type RecallScope,
	type SessionEntry,
	type SessionMeta,
} from "./recall-shared";

export { resolveGlobalSessionRoot } from "./session-paths";

export interface RecallHistoryOptions extends DiscoveryOptions {
	currentSessionId: string;
	currentSessionName?: string;
	currentSessionEntries: SessionEntry[];
	currentSessionBranchIds?: Set<string>;
	branchScope: RecallScope;
	maxSessions: number;
}

export interface RecallHistory {
	entries: RenderedEntry[];
	sessions: RecallSessionInfo[];
	availableSessions: number;
	currentSessionId: string;
	currentSessionShortId: string;
}

const currentSessionInfo = (
	options: RecallHistoryOptions,
	currentSessionShortId: string,
	messageCount: number,
): RecallSessionInfo => ({
	sessionId: options.currentSessionId,
	sessionShortId: currentSessionShortId,
	sessionName: options.currentSessionName,
	cwd: options.currentCwd,
	local: true,
	isCurrentSession: true,
	path: options.currentSessionFile,
	modified: Number.POSITIVE_INFINITY,
	messageCount,
});

/**
 * Build the read-only cross-session recall pool.
 *
 * Local mode scans the current cwd's session directory. Global mode scans the
 * Pi session root. Candidates are sorted with current-cwd sessions first and
 * each group by newest modification time, then capped. The current session is
 * always included and is not re-read from disk.
 */
export const buildRecallHistory = (options: RecallHistoryOptions): RecallHistory => {
	const currentSessionShortId = shortSessionId(options.currentSessionId);
	const currentMeta: SessionMeta = {
		sessionId: options.currentSessionId,
		sessionShortId: currentSessionShortId,
		sessionName: options.currentSessionName,
		sessionCwd: options.currentCwd,
		isCurrentSession: true,
		local: true,
	};
	const allowed =
		options.branchScope === "lineage"
			? options.currentSessionBranchIds
			: undefined;
	const currentEntries = renderSessionEntries(
		options.currentSessionEntries,
		allowed,
		currentMeta,
	);

	const candidates = collectSessionCandidates(options);
	const maxSessions = Math.max(1, Math.floor(options.maxSessions) || 1);
	const selected = selectSessionCandidates(candidates, maxSessions);

	const entries: RenderedEntry[] = [...currentEntries];
	const sessions: RecallSessionInfo[] = [
		currentSessionInfo(options, currentSessionShortId, currentEntries.length),
	];
	for (const candidate of selected) {
		const loaded = loadSessionCandidate(
			candidate,
			options.currentCwd,
			options.branchScope,
		);
		if (!loaded) continue;
		entries.push(...loaded.entries);
		sessions.push(loaded.info);
	}

	return {
		entries,
		sessions,
		availableSessions: candidates.length + 1,
		currentSessionId: options.currentSessionId,
		currentSessionShortId,
	};
};
