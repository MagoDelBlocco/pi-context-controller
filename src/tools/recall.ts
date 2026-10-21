import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	renderExpanded,
	renderRecent,
	scopePrefix,
	searchPage,
	getActiveLineageEntryIds,
	loadAllMessages,
	type RecallScope,
} from "../recall-shared";

const resolveScope = (scope: string | undefined): RecallScope =>
	typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

export const registerRecallTool = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search session history. Defaults to active lineage; use scope:'all' to include off-lineage branches. " +
			"Supports regex queries, paging, and expand indices.",
		promptSnippet:
			"recall: Search history; default scope is active lineage. Use scope:'all' for off-lineage branches.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance.",
				}),
			),
			expand: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						"Entry indices to return full untruncated content for. Combines with query: the search page is returned first, then the expanded entries.",
				}),
			),
			page: Type.Optional(
				Type.Number({
					description:
						"Page number (1-based) for paginated search results. Default: 1.",
				}),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("lineage"), Type.Literal("all")], {
					description:
						"Search scope. Default: lineage; all includes off-lineage branches.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "No session file available." }],
					details: undefined,
				};
			}

			const scope = resolveScope(params.scope);
			const lineageEntryIds =
				scope === "lineage"
					? getActiveLineageEntryIds(ctx.sessionManager)
					: undefined;
			const entries = loadAllMessages(sessionFile, lineageEntryIds);

			// `query` and `expand` are independent. With both, the ranked search page
			// comes first and the full text of the expanded entries follows.
			const parts: string[] = [];
			const query = params.query?.trim();

			if (query) {
				const page = searchPage(entries, query, params.page ?? 1, scope);
				const hint =
					page.page < page.totalPages
						? `\n--- Use page:${page.page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
						: "";
				parts.push(page.text + hint);
			} else if (!params.expand?.length) {
				parts.push(renderRecent(entries));
			}

			const expanded = renderExpanded(entries, params.expand ?? []);
			if (expanded) parts.push(expanded);

			return {
				content: [
					{ type: "text", text: scopePrefix(scope) + parts.join("\n\n---\n\n") },
				],
				details: undefined,
			};
		},
	});
};
