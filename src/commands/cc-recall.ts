import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { searchEntries } from "../native-bridge";

const PAGE_SIZE = 5;
const DEFAULT_RECENT = 25;

interface SessionEntry {
	type: string;
	id: string;
	message?: any;
}

const textOf = (content: unknown): string => {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text ?? "")
			.join("\n");
	}
	return "";
};

const clip = (text: string, max: number): string => {
	if (text.length <= max) return text;
	const cut = text.lastIndexOf(" ", max);
	const end = cut > max * 0.6 ? cut : max;
	return text.slice(0, end);
};

interface RenderedEntry {
	index: number;
	role: string;
	summary: string;
	fullText: string;
}

const renderMessage = (msg: any, index: number): RenderedEntry => {
	if (msg.role === "user") {
		return {
			index,
			role: "user",
			summary: clip(textOf(msg.content), 300),
			fullText: textOf(msg.content),
		};
	}
	if (msg.role === "toolResult") {
		const prefix = msg.isError ? "ERROR " : "";
		return {
			index,
			role: "tool_result",
			summary: `${prefix}[${msg.toolName}] ${clip(textOf(msg.content), 200)}`,
			fullText: textOf(msg.content),
		};
	}
	if ((msg as any).role === "bashExecution") {
		const cmd = (msg as any).command ?? "";
		const out = (msg as any).output ?? "";
		return {
			index,
			role: "bash",
			summary: clip(`$ ${cmd}\n${out}`, 300),
			fullText: `$ ${cmd}\n${out}`,
		};
	}
	const text = textOf(msg.content);
	return { index, role: "assistant", summary: clip(text, 300), fullText: text };
};

const loadAllMessages = (
	sessionFile: string,
	allowedEntryIds?: Set<string>,
): RenderedEntry[] => {
	const content = readFileSync(sessionFile, "utf-8");
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* skip malformed */
		}
	}
	const rendered: RenderedEntry[] = [];
	let messageIndex = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
		if (allowed) rendered.push(renderMessage(e.message, messageIndex));
		messageIndex++;
	}
	return rendered;
};

const getActiveLineageEntryIds = (sessionManager: any): Set<string> => {
	try {
		const branch = sessionManager.getBranch?.() ?? [];
		if (branch.length > 0)
			return new Set(
				branch
					.map((e: any) => e.id)
					.filter((id: any): id is string => Boolean(id)),
			);
	} catch {
		/* skip */
	}
	try {
		const all = sessionManager.getEntries?.() ?? [];
		return new Set(
			all.map((e: any) => e.id).filter((id: any): id is string => Boolean(id)),
		);
	} catch {
		/* skip */
	}
	return new Set();
};

const formatRecallOutput = (
	hits: Array<{
		index: number;
		role: string;
		summary: string;
		snippet: string;
	}>,
	query?: string,
	headerOverride?: string,
): string => {
	if (hits.length === 0) {
		return query
			? `No matches for "${query}" in session history.`
			: "No entries in session history.";
	}
	const header = headerOverride
		? `${headerOverride} for "${query}":`
		: query
			? `Found ${hits.length} matches for "${query}":`
			: `Session history (${hits.length} entries):`;
	const lines = hits.map((h) => {
		const body = query && h.snippet ? h.snippet : h.summary;
		return `#${h.index} [${h.role}] ${body}`;
	});
	return `${header}\n\n${lines.join("\n\n")}`;
};

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

			const roles = entries.map((e) => e.role);
			const summaries = entries.map((e) => e.summary);
			const fullTexts = entries.map((e) => e.fullText);
			const allResults = searchEntries(roles, summaries, fullTexts, query);

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
