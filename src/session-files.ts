import { closeSync, openSync, readSync, readdirSync } from "fs";
import { join } from "path";
import type { SessionEntry } from "./recall-shared";

const HEADER_SCAN_BYTES = 64 * 1024;
const MAX_SCAN_DEPTH = 6;

export const readSessionHeader = (path: string): SessionEntry | null => {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytes).toString("utf-8").split("\n", 1)[0];
		const entry = JSON.parse(firstLine);
		if (entry.type !== "session" || typeof entry.id !== "string") return null;
		return entry;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

export const listJsonlFiles = (dir: string, depth = 0): string[] => {
	if (depth > MAX_SCAN_DEPTH) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path);
		} else if (entry.isDirectory()) {
			files.push(...listJsonlFiles(path, depth + 1));
		}
	}
	return files;
};
