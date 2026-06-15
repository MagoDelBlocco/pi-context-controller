import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_RECENT,
	PAGE_SIZE,
	formatRecallOutput,
	getActiveLineageEntryIds,
	loadAllMessages,
	search,
} from "../recall-shared";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const PAGE_RE = /\bpage:(\d+)\b/i;

export const registerCcRecallCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("context-controller-recall", {
		description:
			"Search session history. Add scope:all for off-lineage branches.",
		handler: async (args: string, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file available.", "error");
				return;
			}

			const raw = args.trim();
			const scopeMatch = raw.match(SCOPE_RE);
			const scope =
				scopeMatch?.[1]?.toLowerCase() === "all" ? "all" : "lineage";
			const lineageEntryIds =
				scope === "lineage"
					? getActiveLineageEntryIds(ctx.sessionManager)
					: undefined;

			const query = raw.replace(SCOPE_RE, "").replace(PAGE_RE, "").trim();
			const pageMatch = raw.match(PAGE_RE);
			const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;

			const entries = loadAllMessages(sessionFile, lineageEntryIds);

			if (!query) {
				const recent = entries.slice(-DEFAULT_RECENT);
				const hits = recent.map((e) => ({
					index: e.index,
					role: e.role,
					summary: e.summary,
					snippet: "",
				}));
				const output =
					(scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(hits);
				pi.sendMessage(
					{ customType: "cc-recall", content: output, display: true },
					{ triggerTurn: true },
				);
				return;
			}

			const allResults = search(entries, query);
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
					? `\n--- /context-controller-recall ${query}${scope === "all" ? " scope:all" : ""} page:${page + 1} ---`
					: "";
			const output = formatRecallOutput(pageResults, query, header) + footer;
			pi.sendMessage(
				{ customType: "cc-recall", content: output, display: true },
				{ triggerTurn: true },
			);
		},
	});
};
