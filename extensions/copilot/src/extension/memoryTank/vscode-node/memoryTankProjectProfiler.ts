/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MemoryCategory, MemoryTankStore } from './memoryTankStore';

export interface ProfiledEntry {
	readonly kind: string;
	readonly title: string;
	readonly content: string;
	readonly category: MemoryCategory;
	readonly tags: string[];
	readonly meta: Record<string, unknown>;
}

const MAX_DEPTH = 2;
const MAX_CHILDREN = 40;

/** Deep project scan → structured memory-tank entries (not raw chat dumps). */
export async function profileWorkspace(folder: vscode.Uri): Promise<ProfiledEntry[]> {
	const ctx = await collectProjectFacts(folder);
	const entries: ProfiledEntry[] = [];

	entries.push({
		kind: 'projectContext',
		title: `Project overview: ${ctx.workspaceName}`,
		content: renderOverview(ctx),
		category: 'fact',
		tags: ['project', 'context', 'auto', 'overview'],
		meta: { kind: 'projectContext', workspace: folder.fsPath, profiledAt: new Date().toISOString() },
	});

	if (ctx.structure.length > 0) {
		entries.push({
			kind: 'projectStructure',
			title: `Project structure: ${ctx.workspaceName}`,
			content: renderStructure(ctx),
			category: 'architecture',
			tags: ['project', 'structure', 'auto', 'files'],
			meta: { kind: 'projectStructure', workspace: folder.fsPath },
		});
	}

	if (ctx.techStack.length > 0) {
		entries.push({
			kind: 'techStack',
			title: `Tech stack: ${ctx.workspaceName}`,
			content: renderTechStack(ctx),
			category: 'architecture',
			tags: ['project', 'stack', 'auto', 'dependencies'],
			meta: { kind: 'techStack', workspace: folder.fsPath },
		});
	}

	if (ctx.recentCommits.length > 0) {
		entries.push({
			kind: 'gitTimeline',
			title: `Recent git history: ${ctx.gitBranch ?? ctx.workspaceName}`,
			content: renderGitTimeline(ctx),
			category: 'progress',
			tags: ['git', 'history', 'auto', 'timeline'],
			meta: { kind: 'gitTimeline', branch: ctx.gitBranch },
		});
	}

	if (ctx.milestones.length > 0) {
		entries.push({
			kind: 'milestonesIndex',
			title: `Milestones & releases: ${ctx.workspaceName}`,
			content: renderMilestones(ctx),
			category: 'milestone',
			tags: ['milestone', 'release', 'changelog', 'auto'],
			meta: { kind: 'milestonesIndex', count: ctx.milestones.length },
		});
	}

	if (ctx.agentDocs) {
		entries.push({
			kind: 'agentInstructions',
			title: `Agent / contributor instructions`,
			content: ctx.agentDocs,
			category: 'fact',
			tags: ['agents', 'rules', 'conventions', 'auto'],
			meta: { kind: 'agentInstructions' },
		});
	}

	return entries;
}

/** Upsert profiled entries into the store (keyed by meta.kind). */
export async function upsertProfiledEntries(store: MemoryTankStore, entries: ProfiledEntry[]): Promise<number> {
	const existing = await store.list();
	let written = 0;
	for (const e of entries) {
		const prev = existing.find(x => x.meta?.kind === e.kind);
		await store.save({
			updateId: prev?.id,
			title: e.title,
			content: e.content,
			category: e.category,
			tags: e.tags,
			meta: { ...e.meta, profiledAt: new Date().toISOString() },
		});
		written++;
	}
	return written;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface ProjectFacts {
	workspaceName: string;
	workspacePath: string;
	appName: string;
	appVersion: string;
	projectName?: string;
	projectVersion?: string;
	gitBranch?: string;
	gitHead?: string;
	readmeSnippet?: string;
	structure: string[];
	techStack: string[];
	recentCommits: string[];
	milestones: string[];
	scripts: string[];
	keyFiles: string[];
	agentDocs?: string;
}

async function collectProjectFacts(folder: vscode.Uri): Promise<ProjectFacts> {
	const workspaceName = folder.path.split(/[/\\]/).filter(Boolean).pop() || folder.fsPath;
	const facts: ProjectFacts = {
		workspaceName,
		workspacePath: folder.fsPath,
		appName: vscode.env.appName,
		appVersion: vscode.version,
		structure: [],
		techStack: [],
		recentCommits: [],
		milestones: [],
		scripts: [],
		keyFiles: [],
	};

	await readJsonFile(vscode.Uri.joinPath(folder, 'package.json'), pkg => {
		const p = pkg as { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		facts.projectName = p.name;
		facts.projectVersion = p.version;
		if (p.scripts) {
			facts.scripts = Object.entries(p.scripts).slice(0, 20).map(([k, v]) => `${k}: ${v}`);
		}
		const deps = { ...p.dependencies, ...p.devDependencies };
		if (deps) {
			const important = ['typescript', 'react', 'vue', 'angular', 'electron', 'webpack', 'vite', 'next', 'express', 'vscode'];
			for (const [name, ver] of Object.entries(deps)) {
				const base = name.split('/').pop()!.toLowerCase();
				if (important.some(i => base.includes(i)) || Object.keys(deps).length <= 25) {
					facts.techStack.push(`${name}@${ver}`);
				}
			}
			if (facts.techStack.length === 0) {
				facts.techStack.push(...Object.entries(deps).slice(0, 15).map(([k, v]) => `${k}@${v}`));
			}
		}
	});

	await readJsonFile(vscode.Uri.joinPath(folder, 'product.json'), prod => {
		const p = prod as { nameShort?: string; version?: string; commit?: string };
		if (p.nameShort) { facts.projectName = p.nameShort; }
		if (p.version) { facts.projectVersion = p.version; }
		if (p.commit) { facts.keyFiles.push(`product.json commit: ${p.commit.slice(0, 12)}`); }
	});

	for (const rel of ['tsconfig.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'CMakeLists.txt', 'docker-compose.yml', 'Dockerfile']) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, rel));
			facts.keyFiles.push(rel);
		} catch { /* missing */ }
	}

	try {
		const headBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, '.git', 'HEAD'));
		const head = new TextDecoder().decode(headBytes).trim();
		const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
		if (m) {
			facts.gitBranch = m[1];
		} else {
			facts.gitHead = head.slice(0, 12);
		}
	} catch { /* not git */ }

	facts.recentCommits = await readGitLog(folder);
	facts.structure = await scanDirectory(folder, '', 0);
	facts.milestones = await extractMilestones(folder);

	for (const candidate of ['README.md', 'README', 'readme.md']) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, candidate));
			facts.readmeSnippet = firstParagraph(new TextDecoder().decode(bytes));
			break;
		} catch { /* next */ }
	}

	facts.agentDocs = await readAgentDocs(folder);

	return facts;
}

async function readJsonFile(uri: vscode.Uri, fn: (obj: unknown) => void): Promise<void> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		fn(JSON.parse(new TextDecoder().decode(bytes)));
	} catch { /* optional file */ }
}

async function scanDirectory(root: vscode.Uri, rel: string, depth: number): Promise<string[]> {
	if (depth > MAX_DEPTH) { return []; }
	const uri = rel ? vscode.Uri.joinPath(root, rel) : root;
	const lines: string[] = [];
	try {
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const sorted = entries
			.filter(([name]) => !shouldSkip(name))
			.sort((a, b) => a[0].localeCompare(b[0]))
			.slice(0, MAX_CHILDREN);
		for (const [name, type] of sorted) {
			const prefix = rel ? `${rel}/` : '';
			const label = type === vscode.FileType.Directory ? `${prefix}${name}/` : `${prefix}${name}`;
			lines.push(label);
			if (type === vscode.FileType.Directory && depth < MAX_DEPTH) {
				lines.push(...await scanDirectory(root, `${prefix}${name}`, depth + 1));
			}
		}
	} catch { /* unreadable */ }
	return lines;
}

function shouldSkip(name: string): boolean {
	const lower = name.toLowerCase();
	return name.startsWith('.') && !['.github', '.vscode', '.cursor', '.thecoder'].includes(name)
		|| ['node_modules', 'dist', 'out', 'out-vscode-min', 'build', '.git', 'coverage', '__pycache__'].includes(lower);
}

async function readGitLog(folder: vscode.Uri): Promise<string[]> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, '.git', 'logs', 'HEAD'));
		return new TextDecoder().decode(bytes).trim().split('\n').slice(-12)
			.map(line => {
				const tab = line.indexOf('\t');
				return tab >= 0 ? line.slice(tab + 1).trim() : line.trim();
			})
			.filter(Boolean)
			.reverse();
	} catch {
		return [];
	}
}

async function extractMilestones(folder: vscode.Uri): Promise<string[]> {
	const out: string[] = [];
	for (const candidate of ['CHANGELOG.md', 'CHANGELOG', 'releases/README.md', 'docs/ROADMAP.md', 'ROADMAP.md']) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, candidate));
			const text = new TextDecoder().decode(bytes);
			const headings = text.split('\n')
				.filter(l => /^#{1,3}\s+/.test(l.trim()) || /^##\s*\[/.test(l.trim()))
				.slice(0, 25)
				.map(l => l.trim());
			if (headings.length) {
				out.push(`From ${candidate}:`, ...headings);
			}
		} catch { /* next */ }
	}
	try {
		const relDir = vscode.Uri.joinPath(folder, 'releases');
		const entries = await vscode.workspace.fs.readDirectory(relDir);
		const names = entries.map(([n]) => n).filter(n => !n.startsWith('.')).slice(0, 20);
		if (names.length) {
			out.push('releases/ folder:', ...names.map(n => `- ${n}`));
		}
	} catch { /* no releases */ }
	return out;
}

async function readAgentDocs(folder: vscode.Uri): Promise<string | undefined> {
	const chunks: string[] = [];
	for (const rel of ['AGENTS.md', '.github/copilot-instructions.md', '.cursor/rules/fork-upstream-safety.mdc']) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, rel));
			const text = new TextDecoder().decode(bytes);
			chunks.push(`## ${rel}\n\n${truncate(text, 2000)}`);
		} catch { /* optional */ }
	}
	return chunks.length ? chunks.join('\n\n---\n\n') : undefined;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderOverview(ctx: ProjectFacts): string {
	const lines = [
		`# ${ctx.workspaceName}`,
		'',
		'Structured project overview (auto-profiled by TheCoder memory-tank).',
		'',
		'## Identity',
		`- Path: \`${ctx.workspacePath}\``,
		`- Editor: ${ctx.appName} ${ctx.appVersion}`,
	];
	if (ctx.projectName) { lines.push(`- Project: **${ctx.projectName}**${ctx.projectVersion ? ` v${ctx.projectVersion}` : ''}`); }
	if (ctx.gitBranch) { lines.push(`- Git branch: \`${ctx.gitBranch}\``); }
	if (ctx.gitHead) { lines.push(`- Git HEAD: \`${ctx.gitHead}\``); }
	if (ctx.keyFiles.length) {
		lines.push('', '## Key manifest files', ...ctx.keyFiles.map(f => `- ${f}`));
	}
	if (ctx.scripts.length) {
		lines.push('', '## npm scripts', '```', ...ctx.scripts, '```');
	}
	if (ctx.readmeSnippet) {
		lines.push('', '## README excerpt', '', ctx.readmeSnippet);
	}
	return lines.join('\n');
}

function renderStructure(ctx: ProjectFacts): string {
	return [
		`# Directory layout (depth ${MAX_DEPTH})`,
		'',
		'Use this to locate modules, configs, and assets without re-scanning the tree.',
		'',
		'```',
		...ctx.structure.slice(0, 120),
		'```',
	].join('\n');
}

function renderTechStack(ctx: ProjectFacts): string {
	return [
		'# Dependencies & stack',
		'',
		...ctx.techStack.map(d => `- ${d}`),
	].join('\n');
}

function renderGitTimeline(ctx: ProjectFacts): string {
	return [
		'# Recent commits (from git reflog)',
		ctx.gitBranch ? `Branch: \`${ctx.gitBranch}\`` : '',
		'',
		...ctx.recentCommits.map((c, i) => `${i + 1}. ${c}`),
	].filter(Boolean).join('\n');
}

function renderMilestones(ctx: ProjectFacts): string {
	return [
		'# Milestones, changelog headings & releases',
		'',
		'Track project phases here — update CHANGELOG.md or releases/ and re-open the workspace to refresh.',
		'',
		...ctx.milestones.map(m => m.startsWith('From ') || m.startsWith('releases/') ? `\n### ${m}` : `- ${m}`),
	].join('\n');
}

function firstParagraph(text: string): string {
	const para = text.trim().split(/\n\s*\n/, 1)[0];
	return para.length > 900 ? para.slice(0, 900) + '...' : para;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + '\n... [truncated]';
}
