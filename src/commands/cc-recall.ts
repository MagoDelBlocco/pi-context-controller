import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	renderRecent,
	scopePrefix,
	searchPage,
	getActiveLineageEntryIds,
	loadAllMessages,
	type RecallScope,
} from "../recall-shared";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const PAGE_RE = /\bpage:(\d+)\b/i;

const parseArgs = (raw: string): {
	scope: RecallScope;
	query: string;
	page: number;
} => {
	const scope: RecallScope =
		raw.match(SCOPE_RE)?.[1]?.toLowerCase() === "all" ? "all" : "lineage";
	const pageMatch = raw.match(PAGE_RE);
	const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
	const query = raw.replace(SCOPE_RE, "").replace(PAGE_RE, "").trim();
	return { scope, query, page };
};

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

			const { scope, query, page } = parseArgs(args.trim());
			const lineageEntryIds =
				scope === "lineage"
					? getActiveLineageEntryIds(ctx.sessionManager)
					: undefined;
			const entries = loadAllMessages(sessionFile, lineageEntryIds);

			let output: string;
			if (!query) {
				output = scopePrefix(scope) + renderRecent(entries);
			} else {
				const result = searchPage(entries, query, page, scope);
				const hint =
					result.page < result.totalPages
						? `\n--- /context-controller-recall ${query}${scope === "all" ? " scope:all" : ""} page:${result.page + 1} ---`
						: "";
				output = result.text + hint;
			}

			pi.sendMessage(
				{ customType: "cc-recall", content: output, display: true },
				{ triggerTurn: true },
			);
		},
	});
};
