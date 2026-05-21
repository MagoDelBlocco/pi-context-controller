import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const SETTINGS_PATH_DEFAULT = join(
	homedir(),
	".pi",
	"agent",
	"context-controller-config.json",
);
const settingsPath = (): string =>
	typeof process !== "undefined"
		? (process.env.CONTEXT_CONTROLLER_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT)
		: SETTINGS_PATH_DEFAULT;

export interface ContextControllerConfig {
	overrideDefaultCompaction: boolean;
	/** Skip the confirmation dialog on auto-compaction (after first explicit choice). */
	skipConfirmation: boolean;
	debug: boolean;
	truncateUserWords: number;
	truncateAssistantWords: number;
	briefMaxLines: number;
	toolCallsPerTurn: number;
	filesPerCategory: number;
	maxGoals: number;
	maxPreferences: number;
	maxCommits: number;
	maxOutstandingContext: number;
	maxGoalChars: number;
	maxPreferenceChars: number;
	maxOutstandingChars: number;
	bashCommandCap: number;
	toolErrorLineCap: number;
}

export const DEFAULT_CONFIG: ContextControllerConfig = {
	overrideDefaultCompaction: true,
	skipConfirmation: false,
	debug: false,
	truncateUserWords: 256,
	truncateAssistantWords: 200,
	briefMaxLines: 120,
	toolCallsPerTurn: 8,
	filesPerCategory: 10,
	maxGoals: 8,
	maxPreferences: 15,
	maxCommits: 8,
	maxOutstandingContext: 5,
	maxGoalChars: 200,
	maxPreferenceChars: 200,
	maxOutstandingChars: 150,
	bashCommandCap: 120,
	toolErrorLineCap: 150,
};

const readJson = (path: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
};

export function loadConfig(): ContextControllerConfig {
	const parsed = readJson(settingsPath());
	if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
	return { ...DEFAULT_CONFIG, ...(parsed as Partial<ContextControllerConfig>) };
}

export function scaffoldConfig(): void {
	try {
		const path = settingsPath();
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!existsSync(path)) {
			writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
			return;
		}
		const parsed = readJson(path);
		if (!parsed || typeof parsed !== "object") return;
		let changed = false;
		const next: Record<string, unknown> = { ...parsed };
		for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
			if (!(key in next)) {
				next[key] = value;
				changed = true;
			}
		}
		if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	} catch {
		/* best-effort */
	}
}
