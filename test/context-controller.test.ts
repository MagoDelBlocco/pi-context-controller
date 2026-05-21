/**
 * context-controller tests
 *
 * Run with: npx tsx test/context-controller.test.ts
 *
 * Tests:
 * 1. Determinism — identical input produces byte-identical output
 * 2. Resolution-awareness — a fixed blocker drops out of outstanding context
 * 3. False-positive corpus — goals/preferences don't promote junk
 * 4. Reduction sanity — summary is shorter than raw input
 */

import { normalize } from "../src/normalize";
import {
	buildSections,
	formatSummary,
	mergeSummaries,
} from "../src/native-bridge";
import { DEFAULT_CONFIG } from "../src/config";

// Inline Message type to avoid peer dep resolution in tests
interface Message {
	role: string;
	content?:
		| string
		| Array<{
				type: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: Record<string, unknown>;
				mimeType?: string;
		  }>;
	toolName?: string;
	isError?: boolean;
}

let passed = 0;
let failed = 0;

const assert = (condition: boolean, label: string) => {
	if (condition) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}`);
		failed++;
	}
};

const config = DEFAULT_CONFIG;

// ── Helper: create test messages ──────────────────────────────
const userMsg = (text: string): Message => ({
	role: "user",
	content: [{ type: "text", text }],
});

const assistantMsg = (text: string): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
});

const assistantToolCall = (
	name: string,
	args: Record<string, unknown>,
): Message => ({
	role: "assistant",
	content: [{ type: "toolCall", name, arguments: args }],
});

const toolResultMsg = (
	name: string,
	text: string,
	isError = false,
): Message => ({
	role: "toolResult",
	toolName: name,
	content: [{ type: "text", text }],
	isError,
});

const thinkingMsg = (text: string): Message => ({
	role: "assistant",
	content: [{ type: "thinking", thinking: text }],
});

// ── Test 1: Determinism ───────────────────────────────────────
console.log("\n=== Test 1: Determinism ===");
{
	const messages: Message[] = [
		userMsg("Build a REST API with Express"),
		assistantMsg(
			"I'll create an Express server with routes for users and posts.",
		),
		assistantToolCall("write", { file_path: "src/server.ts" }),
		toolResultMsg("write", "File written successfully"),
		assistantToolCall("bash", { command: "npm install express" }),
		toolResultMsg("bash", "added 42 packages"),
		assistantMsg("The server is ready. Run `npm start` to begin."),
		userMsg("Now add authentication with JWT"),
		assistantToolCall("write", { file_path: "src/auth.ts" }),
		toolResultMsg("write", "File written"),
		assistantToolCall("edit", { file_path: "src/server.ts" }),
		toolResultMsg("edit", "File edited"),
		thinkingMsg("I need to add middleware for JWT verification"),
		assistantMsg(
			"Authentication is now integrated. Use /login to get a token.",
		),
	];

	const blocks = normalize(messages);
	const sections1 = buildSections(blocks, config);
	const summary1 = formatSummary(JSON.stringify(sections1));

	// Run again with same input
	const blocks2 = normalize(messages);
	const sections2 = buildSections(blocks2, config);
	const summary2 = formatSummary(JSON.stringify(sections2));

	assert(summary1 === summary2, "Two runs produce byte-identical output");
	assert(summary1.length > 0, "Summary is non-empty");

	// Run 10 times
	let allSame = true;
	for (let i = 0; i < 10; i++) {
		const s = formatSummary(
			JSON.stringify(buildSections(normalize(messages), config)),
		);
		if (s !== summary1) {
			allSame = false;
			break;
		}
	}
	assert(allSame, "10 runs all produce identical output");
}

// ── Test 2: Resolution-awareness ──────────────────────────────
console.log("\n=== Test 2: Resolution-awareness ===");
{
	// Scenario: a build fails, then is fixed
	const messages: Message[] = [
		userMsg("Fix the build error in auth.ts"),
		assistantToolCall("bash", { command: "npm run build" }),
		toolResultMsg(
			"bash",
			"error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
			true,
		),
		assistantMsg(
			"The build is failing because of a type mismatch in auth.ts. The function expects a number but receives a string.",
		),
		assistantToolCall("edit", { file_path: "src/auth.ts" }),
		toolResultMsg("edit", "File edited"),
		assistantToolCall("bash", { command: "npm run build" }),
		toolResultMsg("bash", "Build succeeded! 0 errors."),
		assistantMsg(
			"Fixed! The build is now passing. I converted the string argument to a number using parseInt.",
		),
	];

	const blocks = normalize(messages);
	const sections = buildSections(blocks, config);

	// The outstanding context should NOT contain the build error since it was resolved
	const hasBuildError = sections.outstandingContext.some(
		(item) =>
			item.toLowerCase().includes("error") ||
			item.toLowerCase().includes("fail"),
	);
	assert(
		!hasBuildError,
		"Resolved build error does not appear in outstanding context",
	);

	// Now test with an UNRESOLVED error
	const messages2: Message[] = [
		userMsg("Fix the test failure"),
		assistantToolCall("bash", { command: "npm test" }),
		toolResultMsg(
			"bash",
			"FAIL tests/auth.test.ts - TypeError: Cannot read property 'token' of undefined",
			true,
		),
		assistantMsg("I see the test is failing. Let me investigate."),
		assistantToolCall("read", { file_path: "tests/auth.test.ts" }),
		toolResultMsg("read", "test content..."),
		assistantMsg(
			"The test expects a token but the mock doesn't provide one. I need to fix the mock.",
		),
	];

	const blocks2 = normalize(messages2);
	const sections2 = buildSections(blocks2, config);

	const hasUnresolvedError = sections2.outstandingContext.some(
		(item) =>
			item.toLowerCase().includes("fail") ||
			item.toLowerCase().includes("error") ||
			item.toLowerCase().includes("cannot"),
	);
	assert(
		hasUnresolvedError,
		"Unresolved test failure appears in outstanding context",
	);
}

// ── Test 3: False-positive corpus ─────────────────────────────
console.log("\n=== Test 3: False-positive corpus ===");
{
	// These should NOT be extracted as goals
	const nonGoals = [
		"ok",
		"yes",
		"thanks",
		"```typescript\nconst x = 1;\n```",
		"https://example.com/docs",
		"file:///home/user/project",
		"function handleRequest(req, res) { ... }",
		"const result = await fetch('/api/data');",
		"import { useState } from 'react';",
		"export default class App {}",
		"│ ├─ src/\n│ └─ test/",
		"For each issue, read the comments in full and analyze.",
		"Do NOT implement the changes yet.",
		"Analyze and propose a solution.",
		"Output: a list of changes.",
		"k",
		"yep",
	];

	for (const text of nonGoals) {
		const messages: Message[] = [userMsg(text)];
		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);
		assert(
			sections.sessionGoal.length === 0,
			`Not a goal: "${text.slice(0, 40)}..."`,
		);
	}

	// These SHOULD be extracted as goals
	const realGoals = [
		"Build a REST API with Express and TypeScript",
		"Fix the authentication bug in the login flow",
		"Refactor the database layer to use Prisma",
		"Add unit tests for the user service",
		"Migrate from MongoDB to PostgreSQL",
	];

	for (const text of realGoals) {
		const messages: Message[] = [userMsg(text)];
		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);
		assert(
			sections.sessionGoal.length > 0,
			`Is a goal: "${text.slice(0, 40)}..."`,
		);
	}

	// Preferences: these should NOT be extracted
	const nonPrefs = [
		"Can you use TypeScript for this?",
		"What style do you prefer?",
		"Is there a way to format the output?",
		"How should I name this function?",
	];

	for (const text of nonPrefs) {
		const messages: Message[] = [userMsg(text)];
		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);
		assert(
			sections.userPreferences.length === 0,
			`Not a preference: "${text.slice(0, 40)}..."`,
		);
	}

	// These SHOULD be extracted as preferences
	const realPrefs = [
		"I prefer using TypeScript over JavaScript",
		"Please always use const instead of let",
		"Don't want any console.log statements in production code",
		"Always use arrow functions for callbacks",
		"Never push directly to main branch",
		"Please format all code with prettier",
	];

	for (const text of realPrefs) {
		const messages: Message[] = [userMsg(text)];
		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);
		assert(
			sections.userPreferences.length > 0,
			`Is a preference: "${text.slice(0, 40)}..."`,
		);
	}
}

// ── Test 4: Reduction sanity ──────────────────────────────────
console.log("\n=== Test 4: Reduction sanity ===");
{
	// Build a realistic session
	const messages: Message[] = [
		userMsg(
			"Create a new Express project with TypeScript, ESLint, and Jest. Set up the basic folder structure with src/routes, src/middleware, src/utils, and tests directories.",
		),
		assistantMsg(
			"I'll set up a complete Express project with TypeScript, ESLint, and Jest. Let me start by creating the package.json and tsconfig.json files.",
		),
		assistantToolCall("write", { file_path: "package.json" }),
		toolResultMsg("write", "File written: package.json"),
		assistantToolCall("write", { file_path: "tsconfig.json" }),
		toolResultMsg("write", "File written: tsconfig.json"),
		assistantToolCall("write", { file_path: "eslint.config.js" }),
		toolResultMsg("write", "File written: eslint.config.js"),
		assistantToolCall("bash", {
			command:
				"npm install express @types/express typescript @typescript-eslint/parser @typescript-eslint/eslint-plugin jest ts-jest @types/jest --save-dev",
		}),
		toolResultMsg("bash", "added 127 packages in 12s"),
		assistantToolCall("write", { file_path: "src/server.ts" }),
		toolResultMsg("write", "File written: src/server.ts"),
		assistantToolCall("write", { file_path: "src/routes/index.ts" }),
		toolResultMsg("write", "File written: src/routes/index.ts"),
		assistantToolCall("write", { file_path: "src/middleware/errorHandler.ts" }),
		toolResultMsg("write", "File written: src/middleware/errorHandler.ts"),
		assistantToolCall("write", { file_path: "src/utils/logger.ts" }),
		toolResultMsg("write", "File written: src/utils/logger.ts"),
		assistantToolCall("write", { file_path: "tests/server.test.ts" }),
		toolResultMsg("write", "File written: tests/server.test.ts"),
		assistantMsg(
			"The project is set up with:\n- Express + TypeScript\n- ESLint with TypeScript support\n- Jest for testing\n- Folder structure: src/routes, src/middleware, src/utils, tests\n\nRun `npm run dev` to start the server.",
		),
		userMsg(
			"Now add a health check endpoint at /health that returns the server uptime and memory usage.",
		),
		assistantToolCall("edit", { file_path: "src/routes/index.ts" }),
		toolResultMsg("edit", "File edited: src/routes/index.ts"),
		assistantToolCall("bash", { command: "npm run build" }),
		toolResultMsg("bash", "Build succeeded!"),
		assistantMsg(
			"Health check endpoint added at /health. It returns uptime in seconds and memory usage (RSS, heap used).",
		),
		userMsg("Add rate limiting to all API routes using express-rate-limit"),
		assistantToolCall("bash", { command: "npm install express-rate-limit" }),
		toolResultMsg("bash", "added 3 packages"),
		assistantToolCall("write", { file_path: "src/middleware/rateLimiter.ts" }),
		toolResultMsg("write", "File written: src/middleware/rateLimiter.ts"),
		assistantToolCall("edit", { file_path: "src/server.ts" }),
		toolResultMsg("edit", "File edited: src/server.ts"),
		assistantMsg(
			"Rate limiting is now applied to all API routes. Default: 100 requests per 15 minutes per IP.",
		),
	];

	// Calculate raw input size (all message text, including tool results)
	let rawChars = 0;
	for (const msg of messages) {
		const content = msg.content;
		if (typeof content === "string") rawChars += content.length;
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (part.type === "text") rawChars += (part as any).text.length;
				if (part.type === "toolCall")
					rawChars += JSON.stringify((part as any).arguments ?? {}).length;
			}
		}
		// toolResult messages have content as array of text parts
		if (msg.role === "toolResult" && Array.isArray(content)) {
			for (const part of content) {
				if (part.type === "text") rawChars += (part as any).text.length;
			}
		}
	}

	const blocks = normalize(messages);
	const sections = buildSections(blocks, config);
	const summary = formatSummary(JSON.stringify(sections));

	assert(summary.length > 0, "Summary is non-empty");
	assert(
		summary.length < rawChars,
		`Summary (${summary.length} chars) is shorter than raw input (${rawChars} chars)`,
	);
	const reduction = ((1 - summary.length / rawChars) * 100).toFixed(1);
	console.log(
		`  ℹ Reduction: ${reduction}% (${rawChars} → ${summary.length} chars)`,
	);

	// Verify sections are present
	assert(sections.sessionGoal.length > 0, "Has session goals");
	assert(sections.filesAndChanges.length > 0, "Has file changes");
	assert(sections.briefTranscript.length > 0, "Has brief transcript");
}

// ── Test 5: Merge across compactions ──────────────────────────
console.log("\n=== Test 5: Merge across compactions ===");
{
	// First compaction
	const messages1: Message[] = [
		userMsg("Build a user authentication system"),
		assistantToolCall("write", { file_path: "src/auth.ts" }),
		toolResultMsg("write", "OK"),
		assistantToolCall("write", { file_path: "src/db.ts" }),
		toolResultMsg("write", "OK"),
		assistantMsg("Auth system created."),
	];

	const sections1 = buildSections(normalize(messages1), config);
	const summary1 = formatSummary(JSON.stringify(sections1));

	// Second compaction
	const messages2: Message[] = [
		userMsg("Add password reset functionality"),
		assistantToolCall("write", { file_path: "src/reset.ts" }),
		toolResultMsg("write", "OK"),
		assistantToolCall("edit", { file_path: "src/auth.ts" }),
		toolResultMsg("edit", "OK"),
		assistantMsg("Password reset added."),
	];

	const sections2 = buildSections(normalize(messages2), config);
	const summary2 = formatSummary(JSON.stringify(sections2));

	// Merge
	const merged = mergeSummaries(summary1, summary2, config);

	assert(merged.length > 0, "Merged summary is non-empty");
	// Should contain goals from both
	assert(
		merged.toLowerCase().includes("auth") ||
			merged.toLowerCase().includes("authentication"),
		"Merged contains auth reference",
	);
	// Files should be deduped (auth.ts appears in both compactions)
	// It shows up in "Created" from first compaction and "Modified" from second,
	// plus the section header line itself — so at most 3 occurrences is correct.
	const authTsCount = (merged.match(/auth\.ts/g) || []).length;
	assert(
		authTsCount <= 3,
		`auth.ts appears at most 3x (header + modified + created): found ${authTsCount}`,
	);
}

// ── Summary ───────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);
