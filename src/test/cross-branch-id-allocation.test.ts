import { afterEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

/**
 * ID allocation is branch-blind-proof: an ID issued on ANY branch or worktree,
 * in ANY state (task, draft, completed, archived), is permanently taken — even
 * when checkActiveBranches is false (that flag tunes board/browser loading, not
 * allocation) and even when the holding branch is older than activeBranchDays.
 *
 * Regression context: with checkActiveBranches=false the allocator only saw the
 * current branch, so two branches off the same base each issued the same next
 * ID and the collision surfaced at merge time. Flipping the flag was not enough
 * either: the latest-state filter dropped IDs whose only occurrence was a draft
 * or an archived item on another branch.
 */
describe("cross-branch and cross-worktree ID allocation", () => {
	let testDir: string;

	afterEach(async () => {
		if (testDir) {
			await safeCleanup(testDir);
		}
	});

	async function createRepository(projectName: string): Promise<string> {
		const mainRepo = join(testDir, "repo");
		await mkdir(mainRepo, { recursive: true });
		await $`git init -b main`.cwd(mainRepo).quiet();
		await $`git config user.name "Test User"`.cwd(mainRepo).quiet();
		await $`git config user.email test@example.com`.cwd(mainRepo).quiet();

		const core = new Core(mainRepo);
		await initializeTestProject(core, projectName, true);
		return mainRepo;
	}

	async function configureLoading(repo: string, options: { checkActiveBranches: boolean }): Promise<void> {
		const core = new Core(repo);
		const config = await core.fs.loadConfig();
		if (!config) throw new Error("missing config");
		config.checkActiveBranches = options.checkActiveBranches;
		config.remoteOperations = false;
		await core.fs.saveConfig(config);
		await commitAll(repo, "test: configure loading");
	}

	async function commitAll(repo: string, message: string): Promise<void> {
		await $`git add -A`.cwd(repo).quiet();
		await $`git commit -m ${message}`.cwd(repo).quiet();
	}

	it("allocates above a task that exists only on another branch, even with checkActiveBranches=false", async () => {
		testDir = createUniqueTestDir("branch-id-task");
		const repo = await createRepository("Branch ID Task");
		await configureLoading(repo, { checkActiveBranches: false });

		await $`git checkout -b feature`.cwd(repo).quiet();
		const onBranch = await new Core(repo).createTaskFromInput({ title: "Branch-only task" }, false);
		expect(onBranch.task.id).toBe("TASK-1");
		await commitAll(repo, "task on feature branch");
		await $`git checkout main`.cwd(repo).quiet();

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});

	it("allocates above a DRAFT that exists only on another branch", async () => {
		// Drafts were the real-world hole: even with checkActiveBranches=true the
		// latest-state filter dropped an ID whose only occurrence was a draft on
		// another branch, so the next create reissued it.
		testDir = createUniqueTestDir("branch-id-draft");
		const repo = await createRepository("Branch ID Draft");
		await configureLoading(repo, { checkActiveBranches: true });

		await $`git checkout -b feature`.cwd(repo).quiet();
		const draft = await new Core(repo).createTaskFromInput({ title: "Branch-only draft", status: "Draft" }, false);
		expect(draft.task.id).toBe("TASK-1");
		await commitAll(repo, "draft on feature branch");
		await $`git checkout main`.cwd(repo).quiet();

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});

	it("allocates above an ARCHIVED task that exists only on another branch", async () => {
		testDir = createUniqueTestDir("branch-id-archived");
		const repo = await createRepository("Branch ID Archived");
		await configureLoading(repo, { checkActiveBranches: true });

		await $`git checkout -b feature`.cwd(repo).quiet();
		const core = new Core(repo);
		const created = await core.createTaskFromInput({ title: "Doomed task" }, false);
		expect(created.task.id).toBe("TASK-1");
		expect(await core.archiveTask("task-1", false)).toBe(true);
		await commitAll(repo, "archived task on feature branch");
		await $`git checkout main`.cwd(repo).quiet();

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});

	it("allocates above an ARCHIVED DRAFT that exists only on another branch", async () => {
		// archive/drafts was unmapped in the branch-tree scan, so a draft archived
		// on another branch used to be invisible to allocation.
		testDir = createUniqueTestDir("branch-id-archived-draft");
		const repo = await createRepository("Branch ID Archived Draft");
		await configureLoading(repo, { checkActiveBranches: true });

		await $`git checkout -b feature`.cwd(repo).quiet();
		const core = new Core(repo);
		const draft = await core.createTaskFromInput({ title: "Doomed draft", status: "Draft" }, false);
		expect(draft.task.id).toBe("TASK-1");
		expect(await core.archiveDraft("task-1", false)).toBe(true);
		await commitAll(repo, "archived draft on feature branch");
		await $`git checkout main`.cwd(repo).quiet();

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});

	it("allocates above an uncommitted DRAFT in a sibling worktree", async () => {
		// A draft created in another worktree exists in NO git ref until it is
		// committed, so only the worktree filesystem scan can see it.
		testDir = createUniqueTestDir("worktree-id-draft");
		const repo = await createRepository("Worktree ID Draft");
		await configureLoading(repo, { checkActiveBranches: false });

		const sibling = join(testDir, "worktrees", "feature-draft");
		await $`git worktree add ${sibling} -b feature-draft`.cwd(repo).quiet();

		const draft = await new Core(sibling).createTaskFromInput({ title: "Worktree draft", status: "Draft" }, false);
		expect(draft.task.id).toBe("TASK-1");

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});

	it("allocates above IDs on branches older than activeBranchDays", async () => {
		testDir = createUniqueTestDir("branch-id-stale");
		const repo = await createRepository("Branch ID Stale");
		await configureLoading(repo, { checkActiveBranches: true });

		const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
		const staleEnv = {
			...process.env,
			GIT_AUTHOR_DATE: staleDate,
			GIT_COMMITTER_DATE: staleDate,
		};

		await $`git checkout -b stale-feature`.cwd(repo).quiet();
		const onBranch = await new Core(repo).createTaskFromInput({ title: "Stale branch task" }, false);
		expect(onBranch.task.id).toBe("TASK-1");
		await $`git add -A`.cwd(repo).env(staleEnv).quiet();
		await $`git commit -m "task on stale branch"`.cwd(repo).env(staleEnv).quiet();
		await $`git checkout main`.cwd(repo).quiet();

		const onMain = await new Core(repo).createTaskFromInput({ title: "Main task" }, false);
		expect(onMain.task.id).toBe("TASK-2");
	});
});
