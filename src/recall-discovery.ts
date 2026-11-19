import { statSync } from "fs";
import { resolve } from "path";
import { listJsonlFiles, readSessionHeader } from "./session-files";
import {
	scanDirectories,
	sameCwd,
	type SessionStoreOptions,
} from "./session-paths";
import type { SessionEntry } from "./recall-shared";

export type DiscoveryOptions = SessionStoreOptions;

export interface SessionCandidate {
	path: string;
	header: SessionEntry;
	modified: number;
	local: boolean;
}

const makeCandidate = (
	path: string,
	options: DiscoveryOptions,
): SessionCandidate | null => {
	const resolved = resolve(path);
	const currentFile = options.currentSessionFile;
	if (currentFile && resolved === resolve(currentFile)) return null;
	const header = readSessionHeader(resolved);
	if (!header) return null;
	try {
		const modified = statSync(resolved).mtimeMs;
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const local = sameCwd(cwd, options.currentCwd);
		if (options.historyScope === "local" && !local) return null;
		return { path: resolved, header, modified, local };
	} catch {
		return null;
	}
};

export const collectSessionCandidates = (
	options: DiscoveryOptions,
): SessionCandidate[] => {
	const candidates = new Map<string, SessionCandidate>();
	for (const dir of scanDirectories(options)) {
		for (const file of listJsonlFiles(dir)) {
			const candidate = makeCandidate(file, options);
			if (candidate && !candidates.has(candidate.path)) {
				candidates.set(candidate.path, candidate);
			}
		}
	}
	return [...candidates.values()];
};

export const selectSessionCandidates = (
	candidates: SessionCandidate[],
	maxSessions: number,
): SessionCandidate[] => {
	const sorted = [...candidates].sort((a, b) => {
		if (a.local !== b.local) return a.local ? -1 : 1;
		if (a.modified !== b.modified) return b.modified - a.modified;
		return a.path.localeCompare(b.path);
	});
	return sorted.slice(0, maxSessions - 1);
};
