import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { normalize } from "../normalize";
import {
	buildSections,
	formatSummary,
	mergeSummaries,
	wrapLongLines,
} from "../native-bridge";
import { loadConfig } from "../config";

/** Fire a desktop notification so the user knows the dialog is waiting. */
function notifyUser(summary: string, body: string): void {
	try {
		spawn("notify-send", [summary, body], {
			detached: true,
			stdio: "ignore",
		}).unref();
	} catch {
		/* notify-send not available — silently skip */
	}
}

export const CC_COMPACT_INSTRUCTION = "__context_controller__";

const RECALL_NOTE =
	"Use `cc_recall` to search for prior work, decisions, and context from before this summary. " +
	"Do not redo work already completed.";

const SEPARATOR = "\n\n---\n\n";

/** Section headers emitted by formatSummary — used to filter out brief-transcript
 * headers (e.g. [user], [assistant], [tool_error]) when reporting details. */
const SECTION_TITLES = new Set([
	"Session Goal",
	"Files And Changes",
	"Commits",
	"Outstanding Context",
	"User Preferences",
]);

export interface CompactionStats {
	summarized: number;
	kept: number;
	keptTokensEst: number;
}

let lastStats: CompactionStats | null = null;
let lastCompactWasCc = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
};

interface EntryWithMessage {
	entry: { id: string; type: string };
	message: { role: string; content: unknown };
}

export type OwnCutCancelReason = "no_live_messages" | "too_few_live_messages";

export type OwnCutResult =
	| { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
	| { ok: false; reason: OwnCutCancelReason };

export function buildOwnCut(branchEntries: any[]): OwnCutResult {
	let lastCompactionIdx = -1;
	let lastKeptId: string | undefined;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		if (branchEntries[i].type === "compaction") {
			lastCompactionIdx = i;
			lastKeptId = branchEntries[i].firstKeptEntryId;
			break;
		}
	}

	const hasPriorCompaction = lastCompactionIdx >= 0;
	const hasValidKeptId =
		!!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
	const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

	const liveMessages: EntryWithMessage[] = [];
	if (orphanRecovery) {
		for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
			const e = branchEntries[i];
			if (e.type === "compaction") continue;
			if (e.type === "message" && e.message) {
				liveMessages.push({ entry: e, message: e.message });
			}
		}
	} else {
		let foundKept = !lastKeptId;
		for (const e of branchEntries) {
			if (!foundKept && e.id === lastKeptId) foundKept = true;
			if (!foundKept) continue;
			if (e.type === "compaction") continue;
			if (e.type === "message" && e.message) {
				liveMessages.push({ entry: e, message: e.message });
			}
		}
	}

	if (liveMessages.length === 0)
		return { ok: false, reason: "no_live_messages" };
	if (liveMessages.length <= 2)
		return { ok: false, reason: "too_few_live_messages" };

	let cutIdx = liveMessages.length - 1;
	while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
		cutIdx--;
	}

	if (cutIdx <= 0) {
		return {
			ok: true,
			messages: liveMessages.map((e) => e.message),
			firstKeptEntryId: "",
			compactAll: true,
		};
	}

	return {
		ok: true,
		messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
		firstKeptEntryId: liveMessages[cutIdx].entry.id,
		compactAll: false,
	};
}

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions } = event;
		const config = loadConfig();

		const isCc = customInstructions === CC_COMPACT_INSTRUCTION;
		if (!isCc && !config.overrideDefaultCompaction) return;

		// Explicit /context-controller: no dialog, just compact
		if (isCc) {
			return runCompaction(preparation, branchEntries, ctx, config, true);
		}

		// Auto-compaction: ask user (unless skipConfirmation)
		if (!config.skipConfirmation && ctx.hasUI) {
			notifyUser(
				"context-controller: compaction ready",
				"Choose how to compact your session",
			);
			const choice = await ctx.ui.select(
				"context-controller: Compact with algorithmic summary?",
				[
					"Yes — use context-controller",
					"Don't compact yet",
					"Use LLM-based compaction",
				],
			);
			if (choice === "Don't compact yet") {
				return { cancel: true };
			}
			if (choice === "Use LLM-based compaction" || choice === undefined) {
				// Fall through to Pi's default LLM compactor
				return;
			}
			// "Yes — use context-controller" or any other selection → proceed
		}

		return runCompaction(preparation, branchEntries, ctx, config, false);
	});

	/** Shared compaction logic */
	async function runCompaction(
		preparation: any,
		branchEntries: any[],
		ctx: any,
		config: any,
		isExplicit: boolean,
	) {
		const ownCut = buildOwnCut(branchEntries);
		if (!ownCut.ok) {
			try {
				ctx?.ui?.notify?.(
					`context-controller: Nothing to compact (${ownCut.reason})`,
					"warning",
				);
			} catch {}
			return { cancel: true };
		}

		const agentMessages = ownCut.messages;
		const firstKeptEntryId = ownCut.firstKeptEntryId;
		const messages = convertToLlm(agentMessages);

		const keptIdx = branchEntries.findIndex(
			(e: any) => e.id === firstKeptEntryId,
		);
		const keptEntries =
			keptIdx >= 0
				? branchEntries.slice(keptIdx).filter((e: any) => e.type === "message")
				: [];
		const keptChars = keptEntries.reduce((sum: number, e: any) => {
			const c = e.message?.content;
			if (typeof c === "string") return sum + c.length;
			if (Array.isArray(c))
				return (
					sum +
					c.reduce((s: number, p: any) => {
						if (p.text) return s + p.text.length;
						return s;
					}, 0)
				);
			return sum;
		}, 0);
		lastStats = {
			summarized: agentMessages.length,
			kept: keptEntries.length,
			keptTokensEst: Math.round(keptChars / 4),
		};

		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);
		const sectionsJson = JSON.stringify(sections);
		const fresh = formatSummary(sectionsJson);

		const prev = preparation.previousSummary
			? preparation.previousSummary
					.replace(/(\s*---)?\s*Use `cc_recall` to search[\s\S]*$/, "")
					.trim()
			: undefined;
		const merged = prev ? mergeSummaries(prev, fresh, config) : fresh;

		const summary = merged + SEPARATOR + RECALL_NOTE;

		lastCompactWasCc = isExplicit;

		return {
			compaction: {
				summary: wrapLongLines(summary, 120),
				firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {
					compactor: "context-controller",
					version: 1,
					sections: [...summary.matchAll(/^\[(.+?)\]/gm)]
							.map((m) => m[1])
							.filter((name) => SECTION_TITLES.has(name)),
					sourceMessageCount: agentMessages.length,
					previousSummaryUsed: Boolean(preparation.previousSummary),
					metrics: sections.metrics,
				},
			},
		};
	}

	pi.on("session_compact", (event, ctx) => {
		if (!event.fromExtension) return;
		if (lastCompactWasCc) return;
		const stats = lastStats;
		if (!stats) return;
		setTimeout(() => {
			try {
				ctx?.ui?.notify?.(
					`context-controller: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
					"info",
				);
			} catch {}
		}, 500);
	});
};
