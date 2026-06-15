import type { Message } from "@earendil-works/pi-ai";
import type { NormalizedBlockInput } from "./native-bridge";

const sanitize = (text: string): string =>
	text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

const textOf = (content: Message["content"]): string => {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((p: any) => p.type === "text")
		.map((p: any) => p.text)
		.join("\n");
};

const normalizeOne = (
	msg: Message,
	msgIndex: number,
): NormalizedBlockInput[] => {
	if (msg.role === "user") {
		const blocks: NormalizedBlockInput[] = [];
		const text = sanitize(textOf(msg.content));
		if (text)
			blocks.push({
				kind: "user",
				text,
				name: "",
				argsJson: "",
				isError: false,
				command: "",
				output: "",
				exitCode: -1,
				sourceIndex: msgIndex,
			});
		if (msg.content && typeof msg.content !== "string") {
			for (const part of msg.content as any[]) {
				if (part.type === "image") {
					blocks.push({
						kind: "user",
						text: `[image: ${part.mimeType}]`,
						name: "",
						argsJson: "",
						isError: false,
						command: "",
						output: "",
						exitCode: -1,
						sourceIndex: msgIndex,
					});
				}
			}
		}
		return blocks.length > 0
			? blocks
			: [
					{
						kind: "user",
						text: "",
						name: "",
						argsJson: "",
						isError: false,
						command: "",
						output: "",
						exitCode: -1,
						sourceIndex: msgIndex,
					},
				];
	}

	if ((msg as any).role === "bashExecution") {
		const exitCode = (msg as any).exitCode ?? -1;
		return [
			{
				kind: "bash",
				text: "",
				name: "",
				argsJson: "",
				// exitCode -1 means "unknown"; only a positive code is a failure.
				isError: typeof exitCode === "number" && exitCode > 0,
				command: (msg as any).command ?? "",
				output: (msg as any).output ?? "",
				exitCode,
				sourceIndex: msgIndex,
			},
		];
	}

	if (msg.role === "toolResult") {
		return [
			{
				kind: "tool_result",
				text: sanitize(textOf(msg.content)),
				name: msg.toolName,
				argsJson: "",
				isError: msg.isError ?? false,
				command: "",
				output: "",
				exitCode: -1,
				sourceIndex: msgIndex,
			},
		];
	}

	if (msg.role === "assistant") {
		if (!msg.content) return [];
		if (typeof msg.content === "string") {
			return [
				{
					kind: "assistant",
					text: sanitize(msg.content),
					name: "",
					argsJson: "",
					isError: false,
					command: "",
					output: "",
					exitCode: -1,
					sourceIndex: msgIndex,
				},
			];
		}
		const blocks: NormalizedBlockInput[] = [];
		for (const part of msg.content as any[]) {
			if (part.type === "text") {
				blocks.push({
					kind: "assistant",
					text: sanitize(part.text),
					name: "",
					argsJson: "",
					isError: false,
					command: "",
					output: "",
					exitCode: -1,
					sourceIndex: msgIndex,
				});
			} else if (part.type === "thinking") {
				blocks.push({
					kind: "thinking",
					text: sanitize(part.thinking ?? ""),
					name: "",
					argsJson: "",
					isError: false,
					command: "",
					output: "",
					exitCode: -1,
					sourceIndex: msgIndex,
				});
			} else if (part.type === "toolCall") {
				blocks.push({
					kind: "tool_call",
					text: "",
					name: part.name ?? "",
					argsJson:
						typeof part.arguments === "string"
							? part.arguments
							: JSON.stringify(part.arguments ?? {}),
					isError: false,
					command: "",
					output: "",
					exitCode: -1,
					sourceIndex: msgIndex,
				});
			}
		}
		return blocks;
	}

	return [];
};

export const normalize = (messages: Message[]): NormalizedBlockInput[] =>
	messages.flatMap((msg, i) => normalizeOne(msg, i));
