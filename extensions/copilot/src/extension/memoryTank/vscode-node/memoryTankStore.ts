/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { searchBM25, tokenize } from './memoryTankBM25';

/**
 * TheCoder memory-tank
 * ==========================================================================
 *
 * Per-workspace long-term memory store. Backed by a single JSON file at
 * `.thecoder/memory-tank/memory.json` next to the user's project. Each
 * entry is a node in a small semantic graph: it carries title/content,
 * tags, a category, and edges (`links`) to related entries.
 *
 * Why JSON and not MongoDB / SQLite / sqlite-vec?
 *
 *   The user originally asked for "MongoDB" but the actual constraint is
 *   "works inside the portable build, no native binaries, zero infra to
 *   spin up". Adding `better-sqlite3` + `sqlite-vec` would mean:
 *     - cross-platform prebuilds (we already had `rcedit` choke on
 *       Linux/macOS `.node` files during packaging),
 *     - native ABI churn on every Electron upgrade,
 *     - ~10 MB of binary baggage for a feature that, in the limit, holds
 *       a few thousand short documents.
 *   For that load BM25 over JSON is fast (sub-millisecond per query for
 *   <10k docs), gives surprisingly strong recall for the
 *   "what did we decide about X?" workflow, and survives every Electron
 *   bump without rebuilds. If the corpus ever grows past ~50k entries we
 *   can hot-swap the index/storage layer behind this same API.
 *
 * Concurrency model: single-writer, optimistic. Writes go through
 * `_persist()` which serialises via a chained promise so two concurrent
 * `save()` calls don't interleave file writes. Reads always see the
 * latest in-memory state.
 */

export type MemoryCategory =
	| 'decision'
	| 'architecture'
	| 'progress'
	| 'preference'
	| 'fact'
	| 'todo'
	| 'milestone'
	| 'other';

/** A directed edge in the memory graph (`from` and `to` are entry ids). */
export interface MemoryLink {
	to: string;
	relation: string;
	/** Optional 0..1 weight, defaults to 1.0. */
	weight?: number;
}

export interface MemoryEntry {
	id: string;
	createdAt: string;
	updatedAt: string;
	title: string;
	content: string;
	category: MemoryCategory;
	tags: string[];
	links: MemoryLink[];
	/** Free-form metadata (e.g. branch, file paths, model id used to save). */
	meta?: Record<string, unknown>;
}

export interface MemoryDatabase {
	version: 1;
	createdAt: string;
	updatedAt: string;
	entries: MemoryEntry[];
}

export interface SaveOptions {
	title: string;
	content: string;
	category?: MemoryCategory;
	tags?: string[];
	links?: MemoryLink[];
	meta?: Record<string, unknown>;
	/** When set, update the existing entry with this id instead of creating new. */
	updateId?: string;
}

export interface SearchHit {
	entry: MemoryEntry;
	score: number;
	/** Optional 1-hop neighbours from the graph -- always included so the
	 *  model gets related context without a follow-up call. */
	neighbours: MemoryEntry[];
}

export interface SearchOptions {
	query: string;
	limit?: number;
	category?: MemoryCategory;
	tags?: string[];
	includeNeighbours?: boolean;
}

const FOLDER = '.thecoder/memory-tank';
const FILE = 'memory.json';

/**
 * Storage facade with a one-line API surface: `save`, `search`, `list`,
 * `get`, `delete`, `link`. One instance is created per workspace folder
 * via {@link MemoryTankStore.getOrCreate}. Multiple workspace folders are
 * supported: each gets its own JSON file.
 */
export class MemoryTankStore {

	private static readonly _instances = new Map<string /* workspaceKey */, MemoryTankStore>();

	private _db: MemoryDatabase = MemoryTankStore._freshDb();
	private _loaded = false;
	private _writeChain: Promise<void> = Promise.resolve();

	private constructor(
		public readonly workspaceFolder: vscode.Uri,
	) { }

	static async getOrCreateForActiveWorkspace(): Promise<MemoryTankStore | undefined> {
		const folder = MemoryTankStore._pickWorkspaceFolder();
		if (!folder) { return undefined; }
		return MemoryTankStore._getOrCreate(folder);
	}

	/**
	 * Public hook used by the contribution to bootstrap a folder the user
	 * just opened, without depending on the active-editor heuristic.
	 */
	static async getOrCreateFor(folder: vscode.Uri): Promise<MemoryTankStore> {
		return MemoryTankStore._getOrCreate(folder);
	}

	/** All currently-loaded store instances, one per workspace folder. */
	static getLoadedInstances(): MemoryTankStore[] {
		return Array.from(MemoryTankStore._instances.values());
	}

	private static async _getOrCreate(folder: vscode.Uri): Promise<MemoryTankStore> {
		const key = folder.toString();
		let inst = MemoryTankStore._instances.get(key);
		if (!inst) {
			inst = new MemoryTankStore(folder);
			MemoryTankStore._instances.set(key, inst);
		}
		await inst._ensureLoaded();
		return inst;
	}

	private static _pickWorkspaceFolder(): vscode.Uri | undefined {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}
		// Heuristic: prefer the active editor's folder; otherwise first one.
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active) {
			const owner = vscode.workspace.getWorkspaceFolder(active);
			if (owner) { return owner.uri; }
		}
		return folders[0].uri;
	}

	private static _freshDb(): MemoryDatabase {
		const now = new Date().toISOString();
		return { version: 1, createdAt: now, updatedAt: now, entries: [] };
	}

	private _dbFileUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.workspaceFolder, FOLDER, FILE);
	}

	private async _ensureLoaded(): Promise<void> {
		if (this._loaded) { return; }
		try {
			const bytes = await vscode.workspace.fs.readFile(this._dbFileUri());
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as MemoryDatabase;
			if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
				this._db = parsed;
			}
		} catch {
			// First use; keep the in-memory fresh DB and lazily persist on
			// first write. We don't create an empty file proactively so
			// `.thecoder/memory-tank/` only appears once there's actual data.
		}
		this._loaded = true;
	}

	private _persistEnqueue(): Promise<void> {
		this._writeChain = this._writeChain.then(async () => {
			this._db.updatedAt = new Date().toISOString();
			const dir = vscode.Uri.joinPath(this.workspaceFolder, FOLDER);
			try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists */ }
			const text = JSON.stringify(this._db, null, 2);
			await vscode.workspace.fs.writeFile(this._dbFileUri(), new TextEncoder().encode(text));
		}).catch(() => {/* swallow; next call may succeed */ });
		return this._writeChain;
	}

	// -----------------------------------------------------------------------
	// CRUD + search
	// -----------------------------------------------------------------------

	async save(opts: SaveOptions): Promise<MemoryEntry> {
		await this._ensureLoaded();
		const now = new Date().toISOString();
		let entry: MemoryEntry;
		if (opts.updateId) {
			const existing = this._db.entries.find(e => e.id === opts.updateId);
			if (existing) {
				existing.title = opts.title;
				existing.content = opts.content;
				if (opts.category) { existing.category = opts.category; }
				if (opts.tags) { existing.tags = dedupeStrings(opts.tags); }
				if (opts.links) { existing.links = opts.links; }
				if (opts.meta) { existing.meta = { ...(existing.meta ?? {}), ...opts.meta }; }
				existing.updatedAt = now;
				entry = existing;
			} else {
				entry = this._newEntry(opts, now);
				this._db.entries.push(entry);
			}
		} else {
			entry = this._newEntry(opts, now);
			this._db.entries.push(entry);
		}
		await this._persistEnqueue();
		return entry;
	}

	async list(filter?: { category?: MemoryCategory; tags?: string[] }): Promise<MemoryEntry[]> {
		await this._ensureLoaded();
		return this._db.entries
			.filter(e => !filter?.category || e.category === filter.category)
			.filter(e => !filter?.tags?.length || filter.tags!.every(t => e.tags.includes(t)))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async get(id: string): Promise<MemoryEntry | undefined> {
		await this._ensureLoaded();
		return this._db.entries.find(e => e.id === id);
	}

	async delete(id: string): Promise<boolean> {
		await this._ensureLoaded();
		const idx = this._db.entries.findIndex(e => e.id === id);
		if (idx < 0) { return false; }
		this._db.entries.splice(idx, 1);
		// Drop dangling edges that pointed to the removed node.
		for (const e of this._db.entries) {
			e.links = e.links.filter(l => l.to !== id);
		}
		await this._persistEnqueue();
		return true;
	}

	async link(fromId: string, toId: string, relation: string, weight?: number): Promise<boolean> {
		await this._ensureLoaded();
		const from = this._db.entries.find(e => e.id === fromId);
		const to = this._db.entries.find(e => e.id === toId);
		if (!from || !to) { return false; }
		if (!from.links.some(l => l.to === toId && l.relation === relation)) {
			from.links.push({ to: toId, relation, weight });
			from.updatedAt = new Date().toISOString();
			await this._persistEnqueue();
		}
		return true;
	}

	async search(opts: SearchOptions): Promise<SearchHit[]> {
		await this._ensureLoaded();
		const filtered = this._db.entries
			.filter(e => !opts.category || e.category === opts.category)
			.filter(e => !opts.tags?.length || opts.tags.every(t => e.tags.includes(t)));
		if (filtered.length === 0) { return []; }

		const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
		const queryTokens = tokenize(opts.query);
		if (queryTokens.length === 0) {
			// Empty query -> return most recently updated entries (still useful
			// when the agent asks "what's recent?").
			return filtered
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
				.slice(0, limit)
				.map(entry => ({
					entry,
					score: 0,
					neighbours: opts.includeNeighbours === false ? [] : this._collectNeighbours(entry),
				}));
		}

		const corpus = filtered.map(e => ({
			id: e.id,
			text: `${e.title}\n${e.content}\nTags: ${e.tags.join(' ')}\nCategory: ${e.category}`,
		}));
		const ranked = searchBM25(opts.query, corpus, limit);
		const idMap = new Map(filtered.map(e => [e.id, e]));
		const hits: SearchHit[] = [];
		for (const r of ranked) {
			const entry = idMap.get(r.id);
			if (!entry) { continue; }
			hits.push({
				entry,
				score: r.score,
				neighbours: opts.includeNeighbours === false ? [] : this._collectNeighbours(entry),
			});
		}
		return hits;
	}

	getDbPath(): vscode.Uri {
		return this._dbFileUri();
	}

	getStats(): { totalEntries: number; totalLinks: number; categories: Record<string, number> } {
		const categories: Record<string, number> = {};
		let totalLinks = 0;
		for (const e of this._db.entries) {
			categories[e.category] = (categories[e.category] ?? 0) + 1;
			totalLinks += e.links.length;
		}
		return { totalEntries: this._db.entries.length, totalLinks, categories };
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _newEntry(opts: SaveOptions, now: string): MemoryEntry {
		return {
			id: makeId(),
			createdAt: now,
			updatedAt: now,
			title: opts.title.slice(0, 256),
			content: opts.content,
			category: opts.category ?? 'fact',
			tags: dedupeStrings(opts.tags ?? []),
			links: opts.links ?? [],
			meta: opts.meta,
		};
	}

	private _collectNeighbours(entry: MemoryEntry): MemoryEntry[] {
		if (entry.links.length === 0) { return []; }
		const idSet = new Set(entry.links.map(l => l.to));
		// Also include incoming edges so the agent sees what referenced this node.
		for (const e of this._db.entries) {
			if (e.links.some(l => l.to === entry.id)) {
				idSet.add(e.id);
			}
		}
		idSet.delete(entry.id);
		const out: MemoryEntry[] = [];
		for (const id of idSet) {
			const found = this._db.entries.find(e => e.id === id);
			if (found) { out.push(found); }
		}
		return out;
	}
}

function makeId(): string {
	// Short, sortable, no native dep. 32-bit random hex + monotonic ts suffix.
	const ts = Date.now().toString(36);
	const rand = Math.floor(Math.random() * 0xfffff).toString(36).padStart(4, '0');
	return `m_${ts}_${rand}`;
}

function dedupeStrings(arr: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of arr) {
		const n = s.trim().toLowerCase();
		if (!n || seen.has(n)) { continue; }
		seen.add(n);
		out.push(n);
	}
	return out;
}
