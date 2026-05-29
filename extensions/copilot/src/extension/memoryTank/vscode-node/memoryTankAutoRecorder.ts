/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { MemoryTankStore } from './memoryTankStore';
import { digestConversation } from './memoryTankConversationDigest';

interface PendingTurn {
	at: string;
	modelId: string;
	requestId?: string;
	userText?: string;
	assistantText?: string;
	tokens?: { in?: number; out?: number };
}

export interface MemoryTankStats {
	totalEntries: number;
	lastSnapshot?: string;
}

const CONFIG_NS = 'thecoder.memoryTank';

export class MemoryTankAutoRecorder extends Disposable {

	private static readonly IDLE_FLUSH_MS = 60_000;

	private readonly _pending: PendingTurn[] = [];
	private readonly _idleTimer = this._register(new MutableDisposable<vscode.Disposable>());
	private _lastSnapshotAt?: string;

	private readonly _onDidUpdateStats = this._register(new Emitter<MemoryTankStats>());
	public readonly onDidUpdateStats: Event<MemoryTankStats> = this._onDidUpdateStats.event;

	constructor(
		private readonly _log: ILogService,
	) {
		super();
	}

	noteTurn(turn: { modelId: string; requestId?: string; userText?: string; assistantText?: string; tokensIn?: number; tokensOut?: number }): void {
		if (!this._isAutoExtractEnabled()) { return; }
		this._pending.push({
			at: new Date().toISOString(),
			modelId: turn.modelId,
			requestId: turn.requestId,
			userText: trimForBuffer(turn.userText),
			assistantText: trimForBuffer(turn.assistantText),
			tokens: (turn.tokensIn || turn.tokensOut) ? { in: turn.tokensIn, out: turn.tokensOut } : undefined,
		});

		this._idleTimer.value = scheduleOnce(() => {
			void this._flush('idle').catch(err => this._log.warn(`memory-tank flush failed: ${err}`));
		}, MemoryTankAutoRecorder.IDLE_FLUSH_MS);
	}

	async snapshotNow(reason: 'beforeSummary' | 'manual' | 'idle'): Promise<void> {
		this._idleTimer.clear();
		await this._flush(reason);
	}

	private async _flush(reason: 'idle' | 'beforeSummary' | 'manual'): Promise<void> {
		if (this._pending.length === 0) { return; }
		const turns = this._pending.splice(0, this._pending.length);
		const store = await MemoryTankStore.getOrCreateForActiveWorkspace();
		if (!store) {
			this._log.info('memory-tank: snapshot skipped (no workspace folder)');
			return;
		}

		const digested = digestConversation(turns);
		for (const entry of digested) {
			await store.save({
				title: entry.title,
				content: entry.content,
				category: entry.category,
				tags: [...entry.tags, reason],
				meta: { kind: 'conversationDigest', reason, turnCount: turns.length },
			});
		}

		if (this._storeFullTranscripts()) {
			const title = `Conversation transcript (${reason}) — ${turns.length} turn${turns.length === 1 ? '' : 's'}`;
			await store.save({
				title,
				content: renderTurnsMarkdown(turns),
				category: 'progress',
				tags: ['conversation', 'auto', 'transcript', reason],
				meta: { kind: 'conversationTranscript', reason, turnCount: turns.length },
			});
		}

		this._lastSnapshotAt = new Date().toISOString();
		this._log.info(`memory-tank: saved ${digested.length} structured entries (${reason}, ${turns.length} turns)`);
		this.refreshStats();
	}

	refreshStats(): void {
		let totalEntries = 0;
		for (const inst of MemoryTankStore.getLoadedInstances()) {
			totalEntries += inst.getStats().totalEntries;
		}
		this._onDidUpdateStats.fire({ totalEntries, lastSnapshot: this._lastSnapshotAt });
	}

	private _isAutoExtractEnabled(): boolean {
		return vscode.workspace.getConfiguration(CONFIG_NS).get<boolean>('autoExtract', true) !== false;
	}

	private _storeFullTranscripts(): boolean {
		return vscode.workspace.getConfiguration(CONFIG_NS).get<boolean>('storeFullTranscripts', false) === true;
	}
}

let _instance: MemoryTankAutoRecorder | undefined;
export function setMemoryTankAutoRecorder(rec: MemoryTankAutoRecorder | undefined): void {
	_instance = rec;
}
export function getMemoryTankAutoRecorder(): MemoryTankAutoRecorder | undefined {
	return _instance;
}

function trimForBuffer(text: string | undefined): string | undefined {
	if (!text) { return undefined; }
	return text.length > 4000 ? text.slice(0, 4000) + '... [truncated]' : text;
}

function renderTurnsMarkdown(turns: PendingTurn[]): string {
	const lines: string[] = [];
	for (const t of turns) {
		lines.push(`### ${t.at} — ${t.modelId}`);
		if (t.tokens) { lines.push(`*tokens: in=${t.tokens.in ?? 0}, out=${t.tokens.out ?? 0}*`); }
		if (t.userText) { lines.push('', '**User:**', '', t.userText); }
		if (t.assistantText) { lines.push('', '**Assistant:**', '', t.assistantText); }
		lines.push('', '---', '');
	}
	return lines.join('\n');
}

function scheduleOnce(fn: () => void, ms: number): vscode.Disposable {
	const handle = setTimeout(fn, ms);
	return { dispose: () => clearTimeout(handle) };
}
