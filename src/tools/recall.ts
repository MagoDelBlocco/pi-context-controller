import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_RECENT,
	PAGE_SIZE,
	formatRecallOutput,
	getActiveLineageEntryIds,
	loadAllMessages,
	search,
} from "../recall-shared";

export const registerRecallTool = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "cc_recall",
		label: "CC Recall",
		description:
			"Search session history. Defaults to active lineage; use scope:'all' to include off-lineage branches. " +
			"Supports regex queries, paging, and expand indices.",
		promptSnippet:
			"cc_recall: Search history; default scope is active lineage. Use scope:'all' for off-lineage branches.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance.",
				}),
			),
			expand: Type.Optional(
				Type.Array(Type.Number(), {
					description: "Entry indices to return full untruncated content for",
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

			const scope =
				typeof params.scope === "string" && params.scope.toLowerCase() === "all"
					? "all"
					: "lineage";
			const lineageEntryIds =
				scope === "lineage"
					? getActiveLineageEntryIds(ctx.sessionManager)
					: undefined;
			const expandSet = new Set(params.expand ?? []);
			const hasExpand = expandSet.size > 0;
			const entries = loadAllMessages(sessionFile, lineageEntryIds);

			if (hasExpand && !params.query) {
				const byIndex = new Map(entries.map((m) => [m.index, m]));
				const expanded = [...expandSet]
					.map((i) => byIndex.get(i))
					.filter((m): m is NonNullable<typeof m> => Boolean(m));
				const output =
					(scope === "all" ? "Scope: all\n\n" : "") +
					expanded
						.map((e) => `#${e.index} [${e.role}] ${e.fullText}`)
						.join("\n\n");
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			}

			if (params.query?.trim()) {
				const allResults = search(entries, params.query.trim());
				const page = Math.max(1, params.page ?? 1);
				const start = (page - 1) * PAGE_SIZE;
				const pageResults = allResults.slice(start, start + PAGE_SIZE);
				const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
				const scopeSuffix = scope === "all" ? " (scope: all)" : "";
				const header =
					totalPages > 1
						? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
						: `${allResults.length} matches${scopeSuffix}`;
				const footer =
					page < totalPages
						? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
						: "";
				const output =
					formatRecallOutput(pageResults, params.query.trim(), header) + footer;
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			}

			// No query: show recent
			const recent = entries.slice(-DEFAULT_RECENT);
			const hits = recent.map((e) => ({
				index: e.index,
				role: e.role,
				summary: e.summary,
				snippet: "",
			}));
			const output =
				(scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(hits);
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	});
};
