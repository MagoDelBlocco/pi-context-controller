import { join } from "path";
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

export interface SectionMetrics {
	goalCoverage: number;
	errorResolutionRate: number;
	toolSuccessRate: number;
	/**
	 * Fraction of the raw input the brief transcript saved: 1 - briefChars/rawChars,
	 * or 0.0 when it saved nothing. The absolute sizes below make a 0.0 unambiguous.
	 */
	compressionRatio: number;
	rawChars: number;
	briefChars: number;
}

export interface SectionData {
	currentDirection: string[];
	sessionGoal: string[];
	decisions: string[];
	verifiedOutcomes: string[];
	nextStep: string[];
	outstandingContext: string[];
	filesAndChanges: string[];
	commits: string[];
	userPreferences: string[];
	briefTranscript: string;
	metrics: SectionMetrics;
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
	correlationDepth: number;
	dependencyWindow: number;
	goalDedupThreshold: number;
}

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

function configToRaw(config: CompactionConfig): string {
	return Object.entries(config)
		.map(([k, v]) => `${k}=${v}`)
		.join("\x02");
}

export function buildSections(
	blocks: NormalizedBlockInput[],
	config: CompactionConfig,
): SectionData {
	if (!native) throw new Error("context-controller native addon not loaded");
	const json = native.buildSections(blocks, configToRaw(config));
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
		roles,
		summaries,
		fullTexts,
		query,
	);
	return JSON.parse(json);
}

export function wrapLongLines(text: string, maxChars: number): string {
	if (!native) throw new Error("context-controller native addon not loaded");
	return native.wrapLongLines(text, maxChars);
}
