/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MemoryCategory, MemoryEntry, MemoryTankStore, SearchHit } from './memoryTankStore';

/**
 * One language-model-facing tool covering every memory-tank action.
 *
 * Why one tool and not per-action? Two reasons:
 *   1. The model needs less context when picking a tool -- a single
 *      `memory_tank` slot in the tool list reads as "long-term memory"
 *      and is harder to ignore than several near-duplicates.
 *   2. The action schema is small enough (six values) that the model
 *      reliably picks the right one from the description.
 *
 * The tool is registered via plain `vscode.lm.registerTool` instead of the
 * Copilot `ToolRegistry` so it ships independently of the per-model tool
 * routing and works against both Copilot-hosted and BYOK models. The
 * `package.json` `languageModelTools` contribution makes it discoverable
 * to the agent loop the same way as the existing `memory` tool.
 */

type Action =
	| 'save'
	| 'search'
	| 'list'
	| 'get'
	| 'delete'
	| 'link'
	| 'stats';

interface MemoryTankInput {
	action: Action;
	// save / save-update
	id?: string;
	title?: string;
	content?: string;
	category?: MemoryCategory;
	tags?: string[];
	// search
	query?: string;
	limit?: number;
	// link
	from?: string;
	to?: string;
	relation?: string;
	weight?: number;
	// shared
	meta?: Record<string, unknown>;
	includeNeighbours?: boolean;
}

export class MemoryTankTool implements vscode.LanguageModelTool<MemoryTankInput> {

	static readonly toolName = 'thecoder_memory_tank';

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<MemoryTankInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const store = await MemoryTankStore.getOrCreateForActiveWorkspace();
		if (!store) {
			return text('Error: memory-tank requires an open workspace folder.');
		}
		const input = options.input ?? ({} as MemoryTankInput);
		try {
			switch (input.action) {
				case 'save': return await this._save(store, input);
				case 'search': return await this._search(store, input);
				case 'list': return await this._list(store, input);
				case 'get': return await this._get(store, input);
				case 'delete': return await this._delete(store, input);
				case 'link': return await this._link(store, input);
				case 'stats': return await this._stats(store);
				default:
					return text(`Error: unknown action "${String(input.action)}". Valid: save | search | list | get | delete | link | stats.`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return text(`Error: memory-tank ${input.action} failed: ${msg}`);
		}
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<MemoryTankInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const action = options.input?.action;
		const msg = (() => {
			switch (action) {
				case 'save': return options.input?.id
					? vscode.l10n.t('Updating memory note "{0}"', options.input.title ?? options.input.id)
					: vscode.l10n.t('Saving memory note "{0}"', options.input?.title ?? '(untitled)');
				case 'search': return vscode.l10n.t('Searching memory-tank for "{0}"', options.input?.query ?? '');
				case 'list': return vscode.l10n.t('Listing memory-tank entries');
				case 'get': return vscode.l10n.t('Reading memory entry {0}', options.input?.id ?? '');
				case 'delete': return vscode.l10n.t('Removing memory entry {0}', options.input?.id ?? '');
				case 'link': return vscode.l10n.t('Linking memory entries');
				case 'stats': return vscode.l10n.t('Inspecting memory-tank stats');
				default: return vscode.l10n.t('memory-tank: {0}', String(action));
			}
		})();
		return { invocationMessage: msg, pastTenseMessage: msg.replace(/^Saving|Searching|Listing|Reading|Removing|Linking|Inspecting/i, m => m.replace(/ing$/, 'ed')) };
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	private async _save(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		if (!input.title || !input.content) {
			return text('Error: save requires `title` and `content`.');
		}
		const entry = await store.save({
			title: input.title,
			content: input.content,
			category: input.category,
			tags: input.tags,
			meta: input.meta,
			updateId: input.id,
		});
		return text([
			`Saved memory entry **${entry.id}** (${entry.category}).`,
			`Title: ${entry.title}`,
			entry.tags.length ? `Tags: ${entry.tags.join(', ')}` : undefined,
			`File: ${store.getDbPath().fsPath}`,
		].filter(Boolean).join('\n'));
	}

	private async _search(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		if (input.query === undefined) {
			return text('Error: search requires `query` (use empty string to list most recent).');
		}
		const hits = await store.search({
			query: input.query,
			limit: input.limit,
			category: input.category,
			tags: input.tags,
			includeNeighbours: input.includeNeighbours,
		});
		if (hits.length === 0) {
			return text(`No matches for "${input.query}" in memory-tank.`);
		}
		const out: string[] = [`# memory-tank search hits (${hits.length})`, ''];
		for (const h of hits) {
			out.push(formatHit(h));
			out.push('');
		}
		return text(out.join('\n'));
	}

	private async _list(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		const all = await store.list({ category: input.category, tags: input.tags });
		const cap = Math.max(1, Math.min(input.limit ?? 20, 200));
		const shown = all.slice(0, cap);
		const lines = [`# memory-tank entries (${shown.length}/${all.length})`, ''];
		for (const e of shown) {
			lines.push(formatEntryShort(e));
		}
		return text(lines.join('\n'));
	}

	private async _get(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		if (!input.id) { return text('Error: get requires `id`.'); }
		const e = await store.get(input.id);
		if (!e) { return text(`No memory entry with id "${input.id}".`); }
		return text(formatEntryFull(e));
	}

	private async _delete(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		if (!input.id) { return text('Error: delete requires `id`.'); }
		const ok = await store.delete(input.id);
		return text(ok ? `Deleted memory entry ${input.id}.` : `No memory entry with id "${input.id}".`);
	}

	private async _link(store: MemoryTankStore, input: MemoryTankInput): Promise<vscode.LanguageModelToolResult> {
		if (!input.from || !input.to || !input.relation) {
			return text('Error: link requires `from`, `to`, and `relation`.');
		}
		const ok = await store.link(input.from, input.to, input.relation, input.weight);
		return text(ok
			? `Linked ${input.from} -[${input.relation}]-> ${input.to}.`
			: `Could not link (one of the entries does not exist).`);
	}

	private async _stats(store: MemoryTankStore): Promise<vscode.LanguageModelToolResult> {
		const s = store.getStats();
		const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `  - ${k}: ${v}`).join('\n');
		return text([
			`# memory-tank stats`,
			`File: ${store.getDbPath().fsPath}`,
			`Total entries: ${s.totalEntries}`,
			`Total graph links: ${s.totalLinks}`,
			s.totalEntries > 0 ? `Categories:\n${cats}` : '_empty_',
		].join('\n'));
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers (model-readable markdown)
// ---------------------------------------------------------------------------

function formatHit(h: SearchHit): string {
	const e = h.entry;
	const lines: string[] = [];
	lines.push(`## ${e.title}`);
	lines.push(`_id: ${e.id} · category: ${e.category} · score: ${h.score.toFixed(2)} · updated: ${e.updatedAt}_`);
	if (e.tags.length) { lines.push(`Tags: ${e.tags.join(', ')}`); }
	lines.push('');
	lines.push(truncate(e.content, 1200));
	if (h.neighbours.length) {
		lines.push('');
		lines.push(`**Related entries (${h.neighbours.length}):**`);
		for (const n of h.neighbours) {
			lines.push(`  - ${n.id} · ${n.title} (${n.category})`);
		}
	}
	return lines.join('\n');
}

function formatEntryShort(e: MemoryEntry): string {
	return `- **${e.id}** · ${e.category} · ${e.title}${e.tags.length ? ` · [${e.tags.join(', ')}]` : ''}`;
}

function formatEntryFull(e: MemoryEntry): string {
	return [
		`# ${e.title}`,
		`id: ${e.id}`,
		`category: ${e.category}`,
		`tags: ${e.tags.join(', ') || '(none)'}`,
		`created: ${e.createdAt}`,
		`updated: ${e.updatedAt}`,
		e.links.length ? `links: ${e.links.map(l => `${l.to} (${l.relation})`).join(', ')}` : 'links: (none)',
		'',
		e.content,
	].join('\n');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) { return s; }
	return s.slice(0, max - 24) + `\n... [truncated ${s.length - max + 24} chars]`;
}

function text(s: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}
