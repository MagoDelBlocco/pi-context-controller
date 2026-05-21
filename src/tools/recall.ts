import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { searchEntries } from "../native-bridge";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

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
		} catch {}
	}
	const rendered: RenderedEntry[] = [];
	let messageIndex = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
		if (allowed) {
			rendered.push(renderMessage(e.message, messageIndex));
		}
		messageIndex++;
	}
	return rendered;
};

const getActiveLineageEntryIds = (sessionManager: any): Set<string> => {
	try {
		const branch = sessionManager.getBranch?.() ?? [];
		if (branch.length > 0) {
			return new Set(
				branch
					.map((e: any) => e.id)
					.filter((id: any): id is string => Boolean(id)),
			);
		}
	} catch {}
	try {
		const all = sessionManager.getEntries?.() ?? [];
		return new Set(
			all.map((e: any) => e.id).filter((id: any): id is string => Boolean(id)),
		);
	} catch {}
	return new Set();
};

const formatRecallOutput = (
	hits: Array<{
		index: number;
		role: string;
		summary: string;
		snippet: string;
		matchCount: number;
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

			if (hasExpand && !params.query) {
				const entries = loadAllMessages(sessionFile, lineageEntryIds);
				const byIndex = new Map(entries.map((m) => [m.index, m]));
				const expanded = [...expandSet]
					.map((i) => byIndex.get(i))
					.filter((m): m is RenderedEntry => Boolean(m));
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

			const entries = loadAllMessages(sessionFile, lineageEntryIds);
			const roles = entries.map((e) => e.role);
			const summaries = entries.map((e) => e.summary);
			const fullTexts = entries.map((e) => e.fullText);

			let allResults: Array<{
				index: number;
				role: string;
				summary: string;
				snippet: string;
				matchCount: number;
				score: number;
			}>;

			if (params.query?.trim()) {
				allResults = searchEntries(
					roles,
					summaries,
					fullTexts,
					params.query.trim(),
				);
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
			allResults = recent.map((e) => ({
				index: e.index,
				role: e.role,
				summary: e.summary,
				snippet: "",
				matchCount: 0,
				score: 0,
			}));
			const output =
				(scope === "all" ? "Scope: all\n\n" : "") +
				formatRecallOutput(allResults);
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	});
};
