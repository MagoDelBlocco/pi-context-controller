import { join, dirname } from "path";
import { existsSync } from "fs";

// Load the native addon
let native: any;
try {
	const nativeDir = join(__dirname, "..", "native", "build", "Release");
	const addonPath = join(nativeDir, "addon.node");
	if (existsSync(addonPath)) {
		native = require(addonPath);
	}
} catch {
	// Fallback: try relative
	try {
		native = require("../native/build/Release/addon.node");
	} catch {
		native = null;
	}
}

export interface SectionData {
	sessionGoal: string[];
	outstandingContext: string[];
	filesAndChanges: string[];
	commits: string[];
	userPreferences: string[];
	briefTranscript: string;
}

export interface RecallHit {
	index: number;
	role: string;
	summary: string;
	snippet: string;
	matchCount: number;
	score: number;
}

export interface CompactionConfig {
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

// Delimiter constants (must match C++)
const BLOCK_DELIM = "\x01";
const FIELD_DELIM = "\x02";

export interface NormalizedBlockInput {
	kind: string;
	text: string;
	name: string;
	argsJson: string;
	isError: boolean;
	command: string;
	output: string;
	exitCode: number;
	sourceIndex: number;
}

function blocksToRaw(blocks: NormalizedBlockInput[]): string {
	return blocks
		.map((b) =>
			[
				b.kind,
				b.text,
				b.name,
				b.argsJson,
				b.isError ? "1" : "0",
				b.command,
				b.output,
				String(b.exitCode),
				String(b.sourceIndex),
			].join(FIELD_DELIM),
		)
		.join(BLOCK_DELIM);
}

function configToRaw(config: CompactionConfig): string {
	return Object.entries(config)
		.map(([k, v]) => `${k}=${v}`)
		.join(FIELD_DELIM);
}

export function buildSections(
	blocks: NormalizedBlockInput[],
	config: CompactionConfig,
): SectionData {
	if (!native) throw new Error("context-controller native addon not loaded");
	const json = native.buildSections(blocksToRaw(blocks), configToRaw(config));
	return JSON.parse(json);
}

export function formatSummary(sectionsJson: string): string {
	if (!native) throw new Error("context-controller native addon not loaded");
	return native.formatSummary(sectionsJson);
}

export function mergeSummaries(
	previous: string,
	fresh: string,
	config: CompactionConfig,
): string {
	if (!native) throw new Error("context-controller native addon not loaded");
	return native.mergeSummaries(previous, fresh, configToRaw(config));
}

export function searchEntries(
	roles: string[],
	summaries: string[],
	fullTexts: string[],
	query: string,
): RecallHit[] {
	if (!native) throw new Error("context-controller native addon not loaded");
	const json = native.searchEntries(
		roles.join(BLOCK_DELIM),
		summaries.join(BLOCK_DELIM),
		fullTexts.join(BLOCK_DELIM),
		query,
	);
	return JSON.parse(json);
}

export function wrapLongLines(text: string, maxChars: number): string {
	if (!native) throw new Error("context-controller native addon not loaded");
	return native.wrapLongLines(text, maxChars);
}
