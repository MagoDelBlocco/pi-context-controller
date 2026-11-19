import { basename, dirname, resolve } from "path";
import type { RecallHistoryScope } from "./recall-shared";

export interface SessionStoreOptions {
	currentCwd: string;
	currentSessionDir: string;
	currentSessionFile?: string;
	historyScope: RecallHistoryScope;
	globalRoot?: string;
	usesDefaultSessionDir?: boolean;
}

const normalizeCwd = (value: string): string => {
	const resolved = resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const sameCwd = (a: string, b: string): boolean =>
	Boolean(a) && Boolean(b) && normalizeCwd(a) === normalizeCwd(b);

/**
 * Resolve the root that holds every Pi session directory.
 *
 * The default store is `~/.pi/agent/sessions/<encoded-cwd>/`, so the root is
 * the parent. A custom store can be either the root itself or a single encoded
 * project directory; the `--<cwd>--` name identifies the latter.
 */
export const resolveGlobalSessionRoot = (
	sessionDir: string,
	usesDefaultSessionDir = false,
): string => {
	const base = basename(sessionDir);
	const encodedProject = base.startsWith("--") && base.endsWith("--");
	if (usesDefaultSessionDir || encodedProject) return dirname(sessionDir);
	return sessionDir;
};

export const scanDirectories = (options: SessionStoreOptions): string[] => {
	if (options.historyScope === "local") return [options.currentSessionDir];
	const root =
		options.globalRoot ??
		resolveGlobalSessionRoot(
			options.currentSessionDir,
			options.usesDefaultSessionDir ?? false,
		);
	return [options.currentSessionDir, root];
};
