import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import { buildRecallHistory } from "../recall-history";
import {
	getActiveLineageEntryIds,
	historyPrefix,
	renderExpanded,
	renderRecent,
	scopePrefix,
	searchPage,
	type RecallHistoryScope,
	type RecallScope,
} from "../recall-shared";

const resolveScope = (scope: string | undefined): RecallScope =>
	typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

const resolveHistoryScope = (
	scope: string | undefined,
): RecallHistoryScope =>
	typeof scope === "string" && scope.toLowerCase() === "global"
		? "global"
		: "local";

export const registerRecallTool = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search raw session history across one or more Pi sessions. " +
			"historyScope:'local' (default) searches the current session plus persisted sessions whose cwd matches the current cwd; it loads up to recallMaxSessions sessions (default 10), newest first. " +
			"historyScope:'global' searches a capped, most-recent pool of all Pi session histories, with local sessions first and the same session cap. " +
			"scope:'all' includes off-lineage branches within each selected session; default is active lineage. " +
			"No query returns up to 25 recent entries. Query supports OR-ranked multi-word terms, token-prefix matching, and bounded patterns. " +
			"Results are paginated and capped by recallMaxHits (default 100); expand accepts current-session indices or 'shortSessionId:N' for another session.",
		promptSnippet:
			"recall: Search session history; default historyScope is local. Use historyScope:'global' for a capped all-session pool, local first, and scope:'all' for off-lineage branches.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Search terms or safe pattern (e.g. 'hook|inject', 'fail.*build'). Other regex syntax is literal. Multi-word = OR ranked by relevance; terms match token prefixes. Omit query to show recent entries.",
				}),
			),
			expand: Type.Optional(
				Type.Array(
					Type.Union([Type.Number(), Type.String()], {
						description:
							"Entry indices to return full text. Numeric indices resolve in the current session; strings such as '01a1f107:12' resolve a session-qualified entry. Other-session hits use the same #shortSessionId:N form. Combines with query: the search page is returned first, then expanded entries.",
					}),
				),
			),
			page: Type.Optional(
				Type.Number({
					description:
						"Page number (1-based) for paginated search results, 5 results per page. Default: 1.",
				}),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("lineage"), Type.Literal("all")], {
					description:
						"Branch scope within each session. Default: lineage; all includes off-lineage branches.",
				}),
			),
			historyScope: Type.Optional(
				Type.Union([Type.Literal("local"), Type.Literal("global")], {
					description:
						"History pool. Default local: current session plus persisted sessions whose cwd matches the current cwd, up to recallMaxSessions (default 10) newest sessions. Global: capped, most-recent pool of all Pi session histories, local sessions first.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig();
			const sessionManager = ctx.sessionManager;
			const scope = resolveScope(params.scope);
			const historyScope = resolveHistoryScope(params.historyScope);

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

			// `query` and `expand` are independent. With both, the ranked search page
			// comes first and the full text of the expanded entries follows.
			const parts: string[] = [];
			const query = params.query?.trim();

			if (query) {
				const page = searchPage(
					history.entries,
					query,
					params.page ?? 1,
					scope,
					{
						maxHits: config.recallMaxHits,
						localFirst: historyScope === "global",
					},
				);
				const flags = [`page:${page.page + 1}`];
				if (scope === "all") flags.push("scope:'all'");
				if (historyScope === "global") flags.push("historyScope:'global'");
				const hint =
					page.page < page.totalPages
						? `\n--- Use ${flags.join(" with ")} for more results ---`
						: "";
				parts.push(page.text + hint);
			} else if (!params.expand?.length) {
				parts.push(renderRecent(history.entries));
			}

			const expanded = renderExpanded(
				history.entries,
				params.expand ?? [],
				history.currentSessionId,
			);
			if (expanded) parts.push(expanded);

			const prefix =
				historyPrefix(
					historyScope,
					history.sessions.length,
					history.availableSessions,
					historyScope === "global",
				) + scopePrefix(scope);

			return {
				content: [
					{ type: "text", text: prefix + parts.join("\n\n---\n\n") },
				],
				details: {
					historyScope,
					branchScope: scope,
					sessionsUsed: history.sessions.length,
					sessionsAvailable: history.availableSessions,
				},
			};
		},
	});
};
