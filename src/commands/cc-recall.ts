import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import { buildRecallHistory } from "../recall-history";
import {
	getActiveLineageEntryIds,
	historyPrefix,
	renderRecent,
	scopePrefix,
	searchPage,
	type RecallHistoryScope,
	type RecallScope,
} from "../recall-shared";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const PAGE_RE = /\bpage:(\d+)\b/i;
const HISTORY_RE = /\bhistory(?:Scope)?:(local|global)\b/i;

const parseArgs = (
	raw: string,
): {
	scope: RecallScope;
	historyScope: RecallHistoryScope;
	query: string;
	page: number;
} => {
	const scope: RecallScope =
		raw.match(SCOPE_RE)?.[1]?.toLowerCase() === "all" ? "all" : "lineage";
	const historyScope: RecallHistoryScope =
		raw.match(HISTORY_RE)?.[1]?.toLowerCase() === "global"
			? "global"
			: "local";
	const pageMatch = raw.match(PAGE_RE);
	const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
	const query = raw
		.replace(SCOPE_RE, "")
		.replace(PAGE_RE, "")
		.replace(HISTORY_RE, "")
		.trim();
	return { scope, historyScope, query, page };
};

export const registerCcRecallCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("context-controller-recall", {
		description:
			"Search session history. Default historyScope:local; add history:global for all Pi sessions. Add scope:all for off-lineage branches.",
		handler: async (args: string, ctx) => {
			const config = loadConfig();
			const sessionManager = ctx.sessionManager;
			const { scope, historyScope, query, page } = parseArgs(args.trim());
			const currentEntries = sessionManager.getEntries?.() ?? [];
			const header = sessionManager.getHeader?.();
			const currentSessionId =
				header?.id ?? sessionManager.getSessionId?.() ?? "";
			const history = buildRecallHistory({
				currentCwd: sessionManager.getCwd?.() ?? process.cwd(),
				currentSessionDir: sessionManager.getSessionDir?.() ?? "",
				currentSessionFile: sessionManager.getSessionFile(),
				currentSessionId,
				currentSessionName: sessionManager.getSessionName?.(),
				currentSessionEntries: currentEntries,
				currentSessionBranchIds:
					scope === "lineage"
						? getActiveLineageEntryIds(sessionManager)
						: undefined,
				historyScope,
				branchScope: scope,
				maxSessions: config.recallMaxSessions,
			});

			const prefix =
				historyPrefix(
					historyScope,
					history.sessions.length,
					history.availableSessions,
					historyScope === "global",
				) + scopePrefix(scope);

			let output: string;
			if (!query) {
				output = prefix + renderRecent(history.entries);
			} else {
				const result = searchPage(history.entries, query, page, scope, {
					maxHits: config.recallMaxHits,
					localFirst: historyScope === "global",
				});
				const flags = [`page:${result.page + 1}`];
				if (scope === "all") flags.push("scope:all");
				if (historyScope === "global") flags.push("history:global");
				const hint =
					result.page < result.totalPages
						? `\n--- /context-controller-recall ${query} ${flags.join(" ")} ---`
						: "";
				output = prefix + result.text + hint;
			}

			pi.sendMessage(
				{ customType: "cc-recall", content: output, display: true },
				{ triggerTurn: true },
			);
		},
	});
};
