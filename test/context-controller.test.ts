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
	searchEntries,
} from "../src/native-bridge";
import {
	renderExpanded,
	renderRecent,
	searchPage,
} from "../src/recall-shared";
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

// Test runner reporting goes straight to stdout/stderr: this is the report
// channel of the harness, not application logging.
const assert = (condition: boolean, label: string) => {
	if (condition) {
		process.stdout.write(`  ✓ ${label}\n`);
		passed++;
	} else {
		process.stderr.write(`  ✗ ${label}\n`);
		failed++;
	}
};

const config = DEFAULT_CONFIG;

// Single reporting seam for section headers, mirroring `assert` below.
// Writes to stdout directly: this is a test runner's report channel, not
// application logging.
const section = (title: string): void => {
	process.stdout.write(`\n=== ${title} ===\n`);
};

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
section("Test 1: Determinism");
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
section("Test 2: Resolution-awareness");
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
section("Test 3: False-positive corpus");
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
section("Test 4: Reduction sanity");
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
	process.stdout.write(
		`  ℹ Reduction: ${reduction}% (${rawChars} → ${summary.length} chars)\n`,
	);

	// Verify sections are present
	assert(sections.sessionGoal.length > 0, "Has session goals");
	assert(sections.filesAndChanges.length > 0, "Has file changes");
	assert(sections.briefTranscript.length > 0, "Has brief transcript");
}

// ── Test 5: Merge across compactions ──────────────────────────
section("Test 5: Merge across compactions");
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

// ── Test 6: Goal Deduplication ────────────────────────────────
section("Test 6: Goal Deduplication");
{
	// Use a config with dedup enabled (default threshold 0.7)
	const dedupConfig = { ...config };

	// 6a: Identical goals should merge into one with (refined Nx)
	{
		const messages: Message[] = [
			userMsg("Fix the authentication bug in the login flow"),
			assistantMsg("Let me look into it."),
			userMsg("Fix the authentication bug in the login flow"),
			assistantMsg("Still working on it."),
			userMsg("Fix the authentication bug in the login flow"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, dedupConfig);

		// Should have at most 1 goal (the duplicates merged)
		assert(
			sections.sessionGoal.length <= 1,
			`Identical goals merged to ${sections.sessionGoal.length} (expected <= 1)`,
		);

		// The surviving goal should have a refinement suffix
		const hasRefined = sections.sessionGoal.some((g) => g.includes("(refined"));
		assert(hasRefined, "Merged goal has (refined Nx) suffix");
	}

	// 6b: Similar goals should merge
	{
		const messages: Message[] = [
			userMsg("Fix the auth bug in the login flow"),
			assistantMsg("Investigating."),
			userMsg("Fix the auth bug in the login flow again"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, dedupConfig);

		// These two share nearly all trigrams — only "again" vs nothing differs
		// Trigram Jaccard should be well above 0.7
		assert(
			sections.sessionGoal.length <= 1,
			`Similar goals merged to ${sections.sessionGoal.length} (expected <= 1)`,
		);
	}

	// 6c: Dissimilar goals should stay separate
	{
		const messages: Message[] = [
			userMsg("Build a REST API with Express and TypeScript"),
			assistantMsg("Starting the API."),
			userMsg("Write unit tests for the database layer"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, dedupConfig);

		assert(
			sections.sessionGoal.length >= 2,
			`Dissimilar goals kept separate: ${sections.sessionGoal.length} (expected >= 2)`,
		);
	}

	// 6d: Threshold boundary — setting threshold to 0.0 means everything merges
	{
		const zeroThresholdConfig = { ...config, goalDedupThreshold: 0.0 };
		const messages: Message[] = [
			userMsg("Build a REST API with Express"),
			assistantMsg("Starting."),
			userMsg("Write unit tests for the database layer"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, zeroThresholdConfig);

		// With threshold 0.0, similarity >= 0.0 is always true, so second goal merges into first
		assert(
			sections.sessionGoal.length <= 1,
			`Zero threshold merges all: ${sections.sessionGoal.length} (expected <= 1)`,
		);
	}

	// 6e: Threshold 1.0 means only exact trigram match merges (essentially disabled)
	{
		const maxThresholdConfig = { ...config, goalDedupThreshold: 1.0 };
		const messages: Message[] = [
			userMsg("Fix the authentication bug in the login flow"),
			assistantMsg("Investigating."),
			userMsg("Fix the authentication bug in the login flow"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, maxThresholdConfig);

		// With threshold 1.0, only identical trigram distributions merge.
		// Identical strings should still merge (similarity = 1.0 >= 1.0)
		assert(
			sections.sessionGoal.length <= 1,
			`Max threshold still merges identical: ${sections.sessionGoal.length} (expected <= 1)`,
		);
	}

	// 6f: [Scope change] markers are not deduped against semantic goals
	{
		const messages: Message[] = [
			userMsg("Build a REST API with Express"),
			assistantMsg("Starting."),
			userMsg("Actually, instead of Express, let's use Fastify"),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, dedupConfig);

		// Should have the original goal + scope change marker + new goal
		// Scope change markers are structural and should not be deduped
		const hasScopeChange = sections.sessionGoal.some((g) =>
			g.includes("[Scope change]"),
		);
		assert(hasScopeChange, "Scope change marker is preserved");
	}
}

// ── Test 7: Error Pattern Clustering ──────────────────────────
section("Test 7: Error Pattern Clustering");
{
	// 7a: Duplicate errors with different file paths should cluster
	{
		const messages: Message[] = [
			userMsg("Fix the TypeScript errors"),
			assistantToolCall("bash", { command: "npm run build" }),
			toolResultMsg(
				"bash",
				"src/auth.ts:42: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
				true,
			),
			assistantMsg("I see errors in multiple files. Let me fix them."),
			assistantToolCall("bash", { command: "npm run build" }),
			toolResultMsg(
				"bash",
				"src/server.ts:58: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
				true,
			),
			assistantMsg("Still failing."),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);

		// Both errors normalize to the same pattern — should be clustered
		const hasOccurred = sections.outstandingContext.some((item) =>
			item.includes("(occurred"),
		);
		assert(hasOccurred, "Clustered errors have (occurred Nx) suffix");

		// Should have fewer outstanding items than raw errors
		assert(
			sections.outstandingContext.length < 3,
			`Clustered to ${sections.outstandingContext.length} items (expected < 3)`,
		);
	}

	// 7b: Different errors should NOT cluster together
	{
		const messages: Message[] = [
			userMsg("Fix the build"),
			assistantToolCall("bash", { command: "npm run build" }),
			toolResultMsg(
				"bash",
				"src/auth.ts:42: error TS2345: Argument of type 'string' is not assignable.",
				true,
			),
			assistantMsg("One error fixed."),
			assistantToolCall("bash", { command: "npm run build" }),
			toolResultMsg(
				"bash",
				"src/server.ts:10: error TS6133: 'unusedVar' is declared but its value is never read.",
				true,
			),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);

		// These are different error codes — should NOT cluster
		const hasOccurred = sections.outstandingContext.some((item) =>
			item.includes("(occurred"),
		);
		assert(!hasOccurred, "Different errors should not be clustered together");
	}

	// 7c: Errors with varying hex addresses should cluster
	{
		const messages: Message[] = [
			userMsg("Fix the segfault"),
			assistantToolCall("bash", { command: "./run_tests" }),
			toolResultMsg(
				"bash",
				"Segmentation fault (core dumped) at 0x7f3a2b1c in malloc",
				true,
			),
			assistantMsg("Let me check the memory allocation."),
			assistantToolCall("bash", { command: "./run_tests" }),
			toolResultMsg(
				"bash",
				"Segmentation fault (core dumped) at 0xdeadbeef in malloc",
				true,
			),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);

		// Same error pattern, different hex addresses — should cluster
		const hasOccurred = sections.outstandingContext.some((item) =>
			item.includes("(occurred"),
		);
		assert(hasOccurred, "Same error with different hex addresses clusters");
	}

	// 7d: Errors with varying quoted values should cluster
	{
		const messages: Message[] = [
			userMsg("Fix the null reference errors"),
			assistantToolCall("bash", { command: "npm test" }),
			toolResultMsg(
				"bash",
				"TypeError: Cannot read properties of undefined (reading 'token')",
				true,
			),
			assistantMsg("Fixing one."),
			assistantToolCall("bash", { command: "npm test" }),
			toolResultMsg(
				"bash",
				"TypeError: Cannot read properties of undefined (reading 'session')",
				true,
			),
		];

		const blocks = normalize(messages);
		const sections = buildSections(blocks, config);

		// Same error pattern, different quoted property names — should cluster
		const hasOccurred = sections.outstandingContext.some((item) =>
			item.includes("(occurred"),
		);
		assert(hasOccurred, "Same error with different quoted values clusters");
	}
}

// ── Test 8: Commit extraction ─────────────────────────────────
section("Test 8: Commit extraction");
{
	// 8a: commit via a Bash/bash tool call — command lives in argsJson
	const messages: Message[] = [
		userMsg("Commit the changes"),
		assistantToolCall("bash", {
			command: 'git commit -m "fix: resolve auth bug"',
		}),
		toolResultMsg("bash", "[master a1b2c3d] fix: resolve auth bug\n 1 file changed"),
	];
	const sections = buildSections(normalize(messages), config);
	assert(sections.commits.length === 1, "Bash tool-call commit is extracted");
	assert(
		sections.commits.some((c) => c.includes("fix: resolve auth bug")),
		"Commit message is captured",
	);
	assert(
		sections.commits.some((c) => c.includes("a1b2c3d")),
		"Commit hash is captured from the following tool result",
	);

	// 8b: capitalized Bash tool is also handled
	const messagesCap: Message[] = [
		userMsg("Commit it"),
		assistantToolCall("Bash", { command: 'git commit -m "chore: bump version"' }),
		toolResultMsg("Bash", "[main deadbee] chore: bump version"),
	];
	const sectionsCap = buildSections(normalize(messagesCap), config);
	assert(
		sectionsCap.commits.some((c) => c.includes("chore: bump version")),
		"Capitalized Bash tool-call commit is extracted",
	);

	// 8c: inline bash execution (command + output on the entry itself)
	const messagesInline: any[] = [
		userMsg("Commit"),
		{
			role: "bashExecution",
			command: 'git commit -m "feat: add inline commit"',
			output: "[main 1234abc] feat: add inline commit",
			exitCode: 0,
		},
	];
	const sectionsInline = buildSections(normalize(messagesInline), config);
	assert(
		sectionsInline.commits.some((c) => c.includes("feat: add inline commit")),
		"Inline bash commit is extracted",
	);
}

// ── Test 9: Recall regex search ───────────────────────────────
section("Test 9: Recall regex search");
{
	const roles = ["assistant", "assistant", "user"];
	const summaries = ["a", "b", "c"];
	const fullTexts = [
		"the build did fail to build the project",
		"completely unrelated content here",
		"we should inject a hook into the pipeline",
	];

	// 9a: wildcard regex actually matches across characters
	const hits1 = searchEntries(roles, summaries, fullTexts, "fail.*build");
	assert(
		hits1.length === 1 && hits1[0].index === 0,
		"Regex 'fail.*build' matches the build entry only",
	);

	// 9b: alternation
	const hits2 = searchEntries(roles, summaries, fullTexts, "hook|inject");
	assert(
		hits2.length === 1 && hits2[0].index === 2,
		"Regex 'hook|inject' matches the pipeline entry",
	);

	// 9c: a regex that cannot match returns nothing (not a literal fallback hit)
	const hits3 = searchEntries(roles, summaries, fullTexts, "zzz.*qqq");
	assert(hits3.length === 0, "Non-matching regex returns no hits");
}

// ── Test 10: Inline bash failure surfaces as outstanding ──────
section("Test 10: Inline bash failure");
{
	const messages: any[] = [
		userMsg("Run the tests"),
		{
			role: "bashExecution",
			command: "npm test",
			output: "FAIL src/x.test.ts — assertion failed",
			exitCode: 1,
		},
	];
	const sections = buildSections(normalize(messages), config);
	assert(
		sections.outstandingContext.some((item) =>
			item.toLowerCase().includes("fail"),
		),
		"Failed inline bash appears in outstanding context",
	);

	// A successful inline bash should NOT be flagged
	const okMessages: any[] = [
		userMsg("Run the tests"),
		{
			role: "bashExecution",
			command: "npm test",
			output: "All tests passed",
			exitCode: 0,
		},
	];
	const okSections = buildSections(normalize(okMessages), config);
	assert(
		okSections.outstandingContext.length === 0,
		"Successful inline bash is not flagged as outstanding",
	);
}

// ── Test 11: Noise filtering uses Pi tool names ───────────────
section("Test 11: Noise filtering (Pi tool names)");
{
	const messages: Message[] = [
		userMsg("Fix the failing test suite in the parser module"),
		assistantToolCall("todo", { action: "write" }),
		toolResultMsg("todo", "Todo list updated"),
		assistantToolCall("recall", { query: "parser" }),
		toolResultMsg("recall", "3 matches"),
		assistantToolCall("mcp__browser__search", { query: "node-gyp docs" }),
		toolResultMsg("mcp__browser__search", "some results"),
		assistantToolCall("read", { path: "src/parser.ts" }),
		toolResultMsg("read", "file body"),
		assistantToolCall("edit", { path: "src/parser.ts" }),
		toolResultMsg("edit", "edited"),
	];
	const sections = buildSections(normalize(messages), config);
	const brief = sections.briefTranscript;

	assert(!brief.includes("todo"), "todo call is dropped from the brief");
	assert(!brief.includes("* recall"), "recall call is dropped from the brief");
	assert(!brief.includes("mcp__"), "mcp__ tool call is dropped from the brief");
	assert(
		brief.includes('read "src/parser.ts"'),
		"Pi read call still gets a one-liner",
		);
	assert(
		brief.includes('edit "src/parser.ts"'),
		"Pi edit call still gets a one-liner",
		);
	assert(
		sections.filesAndChanges.some((l) => l.startsWith("Modified:")),
		"Modified files still tracked",
	);
	assert(
		sections.filesAndChanges.some((l) => l.startsWith("Read:")),
		"Lowercase Pi read path is tracked in the Read category",
	);
}

// ── Test 12: \uXXXX escapes decode instead of surfacing literally ──
section("Test 12: JSON escape round trip");
{
	// JSON.stringify escapes control characters as \uXXXX, which is the exact form
	// escapeJson emits. formatSummary must decode them, not print "u0001".
	const crafted = JSON.stringify({
		sessionGoal: ["Refactor parser\u0001stage and keep the lexer intact"],
		outstandingContext: [],
		filesAndChanges: [],
		commits: [],
		userPreferences: [],
		briefTranscript: "[user]\nbody",
		metrics: {
			goalCoverage: 0.5,
			errorResolutionRate: 0.25,
			toolSuccessRate: 0.75,
			compressionRatio: 0.125,
		},
	});
	const out = formatSummary(crafted);
	assert(!out.includes("u0001"), "escape is decoded, not left as literal u0001");
	assert(
		out.includes("Refactor parser"),
		"goal text survives the escape round trip",
	);
	assert(out.includes("[Session Goal]"), "sections still render after the change");
}

// ── Test 13: Carried blocker resolution is scoped ─────────────
section("Test 13: Carried blocker resolution");
{
	const previous = [
		"[Outstanding Context]",
		"- [edit] Error: cannot read config from /etc/app.yaml",
		"",
		"---",
		"",
		"[assistant]",
		"Earlier work on the parser.",
	].join("\n");

	// Fresh brief resolves an unrelated problem (the build), not the edit failure.
	const freshUnrelated = [
		"[Outstanding Context]",
		"- [bash] npm run build exited 1",
		"",
		"---",
		"",
		"[assistant]",
		"Fixed the build script; npm run build is green now.",
	].join("\n");
	const mergedUnrelated = mergeSummaries(previous, freshUnrelated, config);
	assert(
		mergedUnrelated.includes("[?] [edit] Error: cannot read config"),
		"Unrelated resolution does not drop the carried edit blocker",
	);

	// Fresh brief resolves the carried blocker and names the same target.
	const freshRelated = [
		"[Outstanding Context]",
		"- [bash] npm run build exited 1",
		"",
		"---",
		"",
		"[assistant]",
		"Fixed the edit that could not read config: app.yaml now parses.",
	].join("\n");
	const mergedRelated = mergeSummaries(previous, freshRelated, config);
	assert(
		!mergedRelated.includes("carried from previous compaction"),
		"Resolution naming the same target drops the carried blocker",
	);

	// A second carry must not stack markers or suffixes.
	const carriedTwice = mergeSummaries(mergedUnrelated, freshUnrelated, config);
	const suffixCount = (
		carriedTwice.match(/carried from previous compaction/g) || []
	).length;
	assert(
		!carriedTwice.includes("[?] [?]") && suffixCount === 1,
		`Repeated merges keep one marker and suffix (found ${suffixCount})`,
	);
}

// ── Test 14: Regex search returns a ranking signal ────────────
section("Test 14: Regex ranking");
{
	const roles = ["assistant", "assistant", "user"];
	const summaries = ["a", "b", "c"];
	const fullTexts = [
		"build failed once",
		"build failed build failed build failed",
		"nothing to see here",
	];
	const hits = searchEntries(roles, summaries, fullTexts, "build|failed");
	assert(hits.length === 2, "Regex matches both build entries");
	assert(
		hits.every((h) => h.score > 0),
		"Regex hits carry a positive score instead of 0",
	);
	assert(
		hits[0].index === 1,
		`Document with more matches ranks first (got #${hits[0].index})`,
	);
	assert(
		hits[0].matchCount > hits[1].matchCount,
		`matchCount reflects occurrences (${hits[0].matchCount} > ${hits[1].matchCount})`,
	);
}

// ── Test 15: Brief shape and metrics ──────────────────────────
section("Test 15: Brief shape and metrics");
{
	const messages: Message[] = [
		userMsg("Ship the report generator for the finance team"),
		assistantMsg("Working on it."),
	];
	const sections = buildSections(normalize(messages), config);
	assert(
		!sections.briefTranscript.startsWith("\n"),
		"Brief transcript has no leading newline",
	);

	const withTools: Message[] = [
		userMsg("Fix the parser test failures now"),
		assistantToolCall("bash", { command: "npm test" }),
		toolResultMsg("bash", "ok"),
		assistantToolCall("bash", { command: "npm run build" }),
		toolResultMsg("bash", "boom", true),
		assistantToolCall("bash", { command: "ls" }),
		toolResultMsg("bash", "file list"),
	];
	const toolSections = buildSections(normalize(withTools), config);
	assert(
		Math.abs(toolSections.metrics.toolSuccessRate - 2 / 3) < 1e-6,
		`toolSuccessRate is 2/3 (got ${toolSections.metrics.toolSuccessRate})`,
	);
	assert(
		toolSections.metrics.goalCoverage === 1,
		`goalCoverage is 1 (got ${toolSections.metrics.goalCoverage})`,
	);
	const toolMetrics = toolSections.metrics;
	assert(
		toolMetrics.compressionRatio >= 0 && toolMetrics.compressionRatio <= 1,
		`compressionRatio stays within [0,1] (got ${toolMetrics.compressionRatio})`,
	);
	assert(
		toolMetrics.rawChars > 0 && toolMetrics.briefChars > 0,
		`absolute sizes reported (raw ${toolMetrics.rawChars}, brief ${toolMetrics.briefChars})`,
	);
	assert(
		Math.abs(
			1 - toolMetrics.briefChars / toolMetrics.rawChars - toolMetrics.compressionRatio,
		) < 1e-6,
		"compressionRatio agrees with the reported absolute sizes",
	);
}

// ── Test 16: recall shared helpers (expand plus query) ────────
section("Test 16: recall helpers");
{
	const entries = [
		{ index: 0, role: "user", summary: "first", fullText: "first full text" },
		{
			index: 1,
			role: "assistant",
			summary: "second about compaction",
			fullText: "second full text about compaction",
		},
	];
	const page = searchPage(entries, "compaction", 1, "lineage");
	assert(page.text.includes("#1"), "searchPage returns the matching entry");
	assert(
		page.total === 1 && page.totalPages === 1 && page.page === 1,
		"searchPage reports paging state",
	);
	const expanded = renderExpanded(entries, [1, 7]);
	assert(
		!!expanded && expanded.includes("second full text about compaction"),
		"renderExpanded returns full untruncated text",
	);
	assert(
		!!expanded && expanded.includes("no entry indexed 7"),
		"renderExpanded names unknown indices instead of dropping them",
	);
	assert(
		renderExpanded(entries, []) === null,
		"renderExpanded with no indices returns null",
	);
	assert(renderRecent(entries).includes("#0"), "renderRecent lists entries");
}

// ── Test 17: escapes decoded, one-liners stay one line ───────
section("Test 17: Escape decoding in one-liners");
{
	const messages: Message[] = [
		userMsg("Write the generator to disk then build it now"),
		assistantToolCall("bash", {
			command: "cat > gen.ts <<'EOF'\nfirst line\nsecond line\nEOF",
		}),
		toolResultMsg("bash", "written"),
		assistantToolCall("bash", { command: "npm run build" }),
		toolResultMsg("bash", "built"),
		// A tab in the argument proves \t decodes and then flattens to a space.
		assistantToolCall("read", { path: "src/a\tb.ts" }),
		toolResultMsg("read", "body"),
	];
	const sections = buildSections(normalize(messages), config);
	const brief = sections.briefTranscript;

	assert(!brief.includes("nfirst line"), "\\n is not rendered as the letter n");
	assert(!brief.includes("atb.ts"), "\\t is not rendered as the letter t");
	assert(brief.includes("src/a b.ts"), "decoded tab flattens to a single space");
	assert(!brief.includes("second line"), "a here-doc body does not sprawl into the brief");
	assert(
		brief.split("\n").filter((l) => l.includes("cat >")).length <= 1,
		"the bash entry occupies one line",
	);
	assert(
		brief.includes('read "src/a b.ts"'),
		"the read entry survives with the decoded path",
	);
}

// ── Test 18: merge keeps chronology and marker adjacency ──────
section("Test 18: Merge chronology");
{
	const previous = [
		"[Session Goal]",
		"- First the original goal",
		"- Then the second goal",
		"",
		"---",
		"",
		"[assistant]",
		"work",
	].join("\n");
	const fresh = [
		"[Session Goal]",
		"- Then the second goal",
		"- [Scope change]",
		"- Now the newest goal",
		"",
		"---",
		"",
		"[assistant]",
		"more work",
	].join("\n");
	const merged = mergeSummaries(previous, fresh, config);
	const goals = merged.split("\n").filter((l) => l.startsWith("- "));

	assert(goals[0].includes("First the original goal"), "original goal stays first");
	assert(
		goals[goals.length - 1].includes("Now the newest goal"),
		"newest goal lands last",
	);
	const markerIdx = goals.findIndex((l) => l.includes("[Scope change]"));
	assert(
		markerIdx >= 0 && !!goals[markerIdx + 1]?.includes("Now the newest goal"),
		"scope marker stays adjacent to the goals it introduces",
	);
	assert(
		goals.filter((l) => l.includes("second goal")).length === 1,
		"a goal present in both passes is not duplicated",
	);

	// Commits must follow chronology, not the alphabet.
	const prevCommits = [
		"[Commits]",
		"- zzz1111: oldest commit",
		"- mmm2222: middle commit",
		"",
		"---",
		"",
		"[assistant]",
		"x",
	].join("\n");
	const freshCommits = [
		"[Commits]",
		"- aaa3333: newest commit",
		"",
		"---",
		"",
		"[assistant]",
		"y",
	].join("\n");
	const mergedCommits = mergeSummaries(prevCommits, freshCommits, config)
		.split("\n")
		.filter((l) => l.startsWith("- "));
	assert(
		mergedCommits[0].includes("oldest") &&
			mergedCommits[mergedCommits.length - 1].includes("newest"),
		"commits keep chronological order, not alphabetical order",
	);
}

// ── Test 19: markup lines are not blockers ────────────────────
section("Test 19: Markup is not a blocker");
{
	const messages: Message[] = [
		userMsg("Document the failure strategy for the parser module"),
		assistantMsg("Notes below for the parser module team."),
		assistantMsg(
			"| 6 | Global failure suppression | the heuristic over-fires on tables badly |",
		),
		assistantMsg("The suite still fails on the tokenizer edge case."),
	];
	const sections = buildSections(normalize(messages), config);
	const joined = sections.outstandingContext.join("\n");

	assert(!joined.includes("|"), "a markdown table row is not harvested as a blocker");
	assert(
		joined.includes("tokenizer"),
		"the genuine prose blocker is still captured",
	);
}

// ── Test 20: only a real git commit is a commit ───────────────
section("Test 20: Quoted git commit");
{
	const quoted: Message[] = [
		userMsg("Write the release helper script to disk now"),
		assistantToolCall("bash", {
			command:
				"cat > release.sh <<'SH'\nconst msg = \"git commit -m 'fake commit message'\";\nSH",
		}),
		toolResultMsg("bash", "written"),
	];
	const quotedSections = buildSections(normalize(quoted), config);
	assert(
		quotedSections.commits.length === 0,
		`git commit quoted inside a script is not a commit (got ${quotedSections.commits.length})`,
	);

	const real: Message[] = [
		userMsg("Commit the calibration fix now"),
		assistantToolCall("bash", { command: 'git commit -m "fix: calibration stage"' }),
		toolResultMsg("bash", "[main abc1234] fix: calibration stage"),
	];
	const realSections = buildSections(normalize(real), config);
	assert(
		realSections.commits.some((c) => c.includes("fix: calibration stage")),
		"a real commit is still extracted",
	);
	assert(
		realSections.commits.some((c) => c.includes("abc1234")),
		"its hash is still captured",
	);
}

// ── Summary ───────────────────────────────────────────────────
process.stdout.write(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);
