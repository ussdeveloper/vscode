/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { MemoryTankStore } from './memoryTankStore';
import { MemoryTankTool } from './memoryTankTool';
import { getMemoryTankAutoRecorder, MemoryTankAutoRecorder, setMemoryTankAutoRecorder } from './memoryTankAutoRecorder';
import { profileWorkspace, upsertProfiledEntries } from './memoryTankProjectProfiler';

/**
 * Activates the memory-tank tool, auto-records project context whenever a
 * workspace is opened, exposes a chat-status indicator with the entry
 * count, and registers maintenance commands.
 *
 * Auto-init flow (the user-visible promise: "ticking the memoryTank tool
 * should immediately create its folder and start collecting data"):
 *   1. On contribution startup, iterate `workspace.workspaceFolders` and for
 *      each one bootstrap `.thecoder/memory-tank/memory.json` with a
 *      "project context" entry (workspace name, app version, vscode
 *      version, package.json version, git HEAD, timestamp).
 *   2. Subscribe to `onDidChangeWorkspaceFolders` and run the same flow
 *      for any newly added folder.
 *   3. Subscribe to chat language-model responses (via
 *      {@link MemoryTankAutoRecorder}) and snapshot the conversation into
 *      memory-tank periodically AND before history compaction.
 *   4. Surface a `vscode.ChatStatusItem` so the user sees the running
 *      entry count next to session cost + balance.
 *
 * Commands:
 *   - `thecoder.memoryTank.openDb`      -- reveal the raw JSON store
 *   - `thecoder.memoryTank.clear`       -- forget all entries (this workspace)
 *   - `thecoder.memoryTank.export`      -- save a copy of the DB somewhere
 *   - `thecoder.memoryTank.recordNow`   -- force-snapshot current chat context
 */
export class MemoryTankContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'memory-tank-contribution';

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		try {
			this._register(vscode.lm.registerTool(MemoryTankTool.toolName, new MemoryTankTool()));
		} catch (err) {
			this._logService.warn(`memory-tank: failed to register tool: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Auto-recorder: wired up first so it's ready by the time the
		// bootstrap save fires its first entry. The accessor mirrors the
		// session-cost / balance singleton pattern: other modules call
		// `getMemoryTankAutoRecorder()` without a direct IoC reference.
		const recorder = new MemoryTankAutoRecorder(this._logService);
		this._register(recorder);
		setMemoryTankAutoRecorder(recorder);
		this._register({ dispose: () => setMemoryTankAutoRecorder(undefined) });

		// Auto-init: walk every currently-open workspace folder and
		// bootstrap memory-tank into each. We swallow per-folder errors
		// so one missing/locked workspace can't break activation.
		void this._bootstrapAllWorkspaces();
		this._register(vscode.workspace.onDidChangeWorkspaceFolders(e => {
			for (const f of e.added) {
				void this._bootstrapWorkspace(f.uri).catch(err => {
					this._logService.warn(`memory-tank: bootstrap failed for ${f.uri.fsPath}: ${err}`);
				});
			}
		}));

		this._register(vscode.commands.registerCommand('thecoder.memoryTank.recordNow', async () => {
			const r = getMemoryTankAutoRecorder();
			if (!r) {
				void vscode.window.showWarningMessage('memory-tank: auto-recorder not initialised.');
				return;
			}
			await r.snapshotNow('manual');
			void vscode.window.showInformationMessage('memory-tank: structured snapshot saved.');
		}));

		this._register(vscode.commands.registerCommand('thecoder.memoryTank.profileProject', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!folder) {
				void vscode.window.showWarningMessage('memory-tank: open a workspace folder first.');
				return;
			}
			await this._bootstrapWorkspace(folder);
			void vscode.window.showInformationMessage('memory-tank: project profile refreshed.');
		}));

		this._register(vscode.commands.registerCommand('thecoder.memoryTank.openDb', async () => {
			const store = await MemoryTankStore.getOrCreateForActiveWorkspace();
			if (!store) {
				void vscode.window.showWarningMessage('memory-tank: open a workspace folder first.');
				return;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(store.getDbPath());
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				void vscode.window.showInformationMessage(`memory-tank: no entries yet (${err instanceof Error ? err.message : String(err)}).`);
			}
		}));

		this._register(vscode.commands.registerCommand('thecoder.memoryTank.clear', async () => {
			const store = await MemoryTankStore.getOrCreateForActiveWorkspace();
			if (!store) {
				void vscode.window.showWarningMessage('memory-tank: open a workspace folder first.');
				return;
			}
			const choice = await vscode.window.showWarningMessage(
				'Delete ALL memory-tank entries for this workspace?',
				{ modal: true },
				'Delete',
			);
			if (choice !== 'Delete') { return; }
			const all = await store.list();
			for (const e of all) { await store.delete(e.id); }
			void vscode.window.showInformationMessage(`memory-tank: removed ${all.length} entries.`);
		}));

		// Chat-status item: lets the user see at-a-glance that memory-tank
		// is active, plus the entry count for the current workspace. We
		// refresh it lazily from `MemoryTankAutoRecorder` whenever a new
		// entry is saved.
		this._registerStatusItem();

		this._register(vscode.commands.registerCommand('thecoder.memoryTank.export', async () => {
			const store = await MemoryTankStore.getOrCreateForActiveWorkspace();
			if (!store) {
				void vscode.window.showWarningMessage('memory-tank: open a workspace folder first.');
				return;
			}
			const target = await vscode.window.showSaveDialog({
				saveLabel: 'Export memory-tank',
				filters: { JSON: ['json'] },
				defaultUri: vscode.Uri.file('memory-tank-export.json'),
			});
			if (!target) { return; }
			try {
				const bytes = await vscode.workspace.fs.readFile(store.getDbPath());
				await vscode.workspace.fs.writeFile(target, bytes);
				void vscode.window.showInformationMessage(`memory-tank: exported to ${target.fsPath}`);
			} catch (err) {
				void vscode.window.showErrorMessage(`memory-tank export failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}));
	}

	// ---------------------------------------------------------------------
	// Bootstrap helpers
	// ---------------------------------------------------------------------

	private async _bootstrapAllWorkspaces(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return; }
		for (const f of folders) {
			try {
				await this._bootstrapWorkspace(f.uri);
			} catch (err) {
				this._logService.warn(`memory-tank: bootstrap failed for ${f.uri.fsPath}: ${err}`);
			}
		}
	}

	/**
	 * Materialise `.thecoder/memory-tank/memory.json` for a workspace folder
	 * and write a "project context" entry. Re-runs are safe -- we update
	 * the existing context entry instead of creating duplicates, keyed by
	 * the deterministic id `m_context_root`.
	 */
	private async _bootstrapWorkspace(folder: vscode.Uri): Promise<void> {
		const store = await MemoryTankStore.getOrCreateFor(folder);
		const autoProfile = vscode.workspace.getConfiguration('thecoder.memoryTank').get<boolean>('autoProfile', true) !== false;

		if (autoProfile) {
			const entries = await profileWorkspace(folder);
			const count = await upsertProfiledEntries(store, entries);
			this._logService.info(`memory-tank: profiled ${folder.fsPath} (${count} structured entries)`);
		} else {
			// Legacy minimal bootstrap
			const ctx = await collectProjectContext(folder);
			const existing = (await store.list()).find(e => e.meta?.kind === 'projectContext');
			await store.save({
				updateId: existing?.id,
				title: `Project: ${ctx.workspaceName}`,
				content: renderProjectContextMarkdown(ctx),
				category: 'fact',
				tags: ['project', 'context', 'auto'],
				meta: { kind: 'projectContext', workspace: folder.fsPath, bootstrappedAt: new Date().toISOString() },
			});
		}

		getMemoryTankAutoRecorder()?.refreshStats();
	}

	// ---------------------------------------------------------------------
	// Status item
	// ---------------------------------------------------------------------

	private _registerStatusItem(): void {
		const recorder = getMemoryTankAutoRecorder();
		if (!recorder) { return; }
		try {
			const item = vscode.chat.createChatStatusItem('thecoder.memoryTank');
			item.title = 'TheCoder memory-tank';
			item.description = 'Initializing...';
			item.command = { command: 'thecoder.memoryTank.openDb', title: 'Open memory store' };
			recorder.onDidUpdateStats(stats => {
				item.description = stats.totalEntries === 0
					? 'no entries yet'
					: `${stats.totalEntries} entries`;
				item.detail = stats.lastSnapshot
					? `Last snapshot: ${stats.lastSnapshot}`
					: undefined;
			});
			recorder.refreshStats();
			this._register(item);
		} catch (err) {
			this._logService.warn(`memory-tank: status item disabled: ${err}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Project-context collection
// ---------------------------------------------------------------------------

interface ProjectContext {
	workspaceName: string;
	workspaceUri: string;
	appName: string;
	appVersion: string;
	vscodeVersion: string;
	projectVersion?: string;
	projectName?: string;
	gitBranch?: string;
	gitHead?: string;
	readmeSnippet?: string;
}

async function collectProjectContext(folder: vscode.Uri): Promise<ProjectContext> {
	const workspaceName = folder.path.split('/').pop() || folder.fsPath;
	const ctx: ProjectContext = {
		workspaceName,
		workspaceUri: folder.toString(),
		appName: vscode.env.appName,
		appVersion: vscode.env.appHost === 'desktop' ? vscode.version : vscode.version,
		vscodeVersion: vscode.version,
	};

	// package.json (Node projects)
	try {
		const pkgBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'package.json'));
		const pkg = JSON.parse(new TextDecoder().decode(pkgBytes)) as { name?: string; version?: string };
		ctx.projectName = pkg.name;
		ctx.projectVersion = pkg.version;
	} catch { /* not a Node project; ignore */ }

	// .git/HEAD -> branch name
	try {
		const headBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, '.git', 'HEAD'));
		const head = new TextDecoder().decode(headBytes).trim();
		const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
		if (m) {
			ctx.gitBranch = m[1];
		} else {
			ctx.gitHead = head;
		}
	} catch { /* not a git repo */ }

	// README first paragraph (cheap project description for the model)
	for (const candidate of ['README.md', 'README', 'README.txt', 'readme.md']) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, candidate));
			const text = new TextDecoder().decode(bytes);
			ctx.readmeSnippet = firstParagraph(text);
			break;
		} catch { /* keep going */ }
	}

	return ctx;
}

function firstParagraph(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) { return ''; }
	const para = trimmed.split(/\n\s*\n/, 1)[0];
	return para.length > 800 ? para.slice(0, 800) + '...' : para;
}

function renderProjectContextMarkdown(ctx: ProjectContext): string {
	const lines: string[] = [
		`# Project context: ${ctx.workspaceName}`,
		'',
		`- Workspace path: \`${ctx.workspaceUri}\``,
		`- App: ${ctx.appName} ${ctx.appVersion}`,
		`- VS Code engine: ${ctx.vscodeVersion}`,
	];
	if (ctx.projectName) { lines.push(`- Project name: ${ctx.projectName}`); }
	if (ctx.projectVersion) { lines.push(`- Project version: ${ctx.projectVersion}`); }
	if (ctx.gitBranch) { lines.push(`- Git branch: \`${ctx.gitBranch}\``); }
	if (ctx.gitHead) { lines.push(`- Git HEAD: \`${ctx.gitHead}\``); }
	if (ctx.readmeSnippet) {
		lines.push('', '## README excerpt', '', ctx.readmeSnippet);
	}
	return lines.join('\n');
}
