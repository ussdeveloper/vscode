/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getModelPricingUSD, ModelPricingUSD } from '../common/byokPricing';
import { ICurrencyService } from './currencyService';

/**
 * Shape of token usage emitted by the OpenAI Chat Completions / Responses
 * APIs (and the Anthropic / Gemini converters in this extension, which already
 * normalise to OpenAI-style fields). We re-declare it here to avoid coupling
 * this module to the heavyweight `APIUsage` type from `platform/networking`.
 */
export interface UsageSnapshot {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

interface PerModelBreakdown {
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	costUSD: number;
	requests: number;
}

/**
 * In-memory session cost tracker. One instance is created at extension
 * activation and shared across every BYOK chat round-trip via the module-level
 * accessor below. The tracker:
 *
 * 1. Multiplies per-request token usage by the model's USD price (built-in
 *    table or `thecoder.pricing.customRates` override) to compute incremental
 *    USD cost.
 * 2. Maintains an accumulated total plus a per-model breakdown for the
 *    hover tooltip.
 * 3. Renders a {@link vscode.ChatStatusItem} pinned to the chat input footer
 *    with the running total formatted in the user's preferred currency.
 *
 * "Session" here means the lifetime of the running window — the tracker
 * resets on extension activation and via the `thecoder.resetSessionCost`
 * command (exposed from `byokContribution`). We intentionally don't tie the
 * counter to a single chat session; sessions are cheap to create and a
 * per-session counter would constantly snap back to zero in normal use.
 */
export class SessionCostTracker implements vscode.Disposable {
	private readonly _byModel = new Map<string, PerModelBreakdown>();
	private _totalUSD = 0;
	private _statusItem: vscode.ChatStatusItem | undefined;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _currencyService: ICurrencyService,
	) {
		this._tryCreateStatusItem();

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('thecoder.pricing.currency')
				|| e.affectsConfiguration('thecoder.sessionCost.show')
				|| e.affectsConfiguration('thecoder.pricing.show')
			) {
				// Re-evaluate visibility and re-render in the new currency.
				if (!this._isUserEnabled()) {
					this._destroyStatusItem();
				} else if (!this._statusItem) {
					this._tryCreateStatusItem();
				}
				this._render();
			}
		}));
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables.length = 0;
		this._destroyStatusItem();
	}

	/**
	 * Record a single chat response's usage against the given model id. Safe
	 * to call with partial usage objects — missing fields are treated as 0.
	 */
	recordUsage(modelId: string, usage: UsageSnapshot | undefined, providerName?: string): void {
		if (!usage) {
			return;
		}
		const customRates = this._readCustomRates();
		const pricing: ModelPricingUSD | undefined = getModelPricingUSD(modelId, customRates, providerName);
		const modelKey = providerName ? `${providerName}/${modelId}` : modelId;
		if (!pricing) {
			// We still count requests for visibility; cost stays at 0 because
			// we have no price for this model.
			this._bumpBreakdown(modelKey, usage, 0);
			this._render();
			return;
		}

		const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
		const rawInputTokens = Math.max(0, (usage.prompt_tokens ?? 0) - cachedTokens);
		const outputTokens = usage.completion_tokens ?? 0;

		const inputUSD = (rawInputTokens / 1_000_000) * pricing.input;
		const cacheUSD = (cachedTokens / 1_000_000) * (pricing.cache ?? pricing.input);
		const outputUSD = (outputTokens / 1_000_000) * pricing.output;
		const requestCost = inputUSD + cacheUSD + outputUSD;

		this._totalUSD += requestCost;
		this._bumpBreakdown(modelKey, usage, requestCost);
		this._render();
	}

	reset(): void {
		this._byModel.clear();
		this._totalUSD = 0;
		this._render();
	}

	getTotalUSD(): number {
		return this._totalUSD;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _bumpBreakdown(modelId: string, usage: UsageSnapshot, costUSD: number): void {
		const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
		const inputTokens = Math.max(0, (usage.prompt_tokens ?? 0) - cachedTokens);
		const outputTokens = usage.completion_tokens ?? 0;

		const existing = this._byModel.get(modelId);
		if (existing) {
			existing.inputTokens += inputTokens;
			existing.cachedTokens += cachedTokens;
			existing.outputTokens += outputTokens;
			existing.costUSD += costUSD;
			existing.requests += 1;
		} else {
			this._byModel.set(modelId, {
				inputTokens,
				cachedTokens,
				outputTokens,
				costUSD,
				requests: 1,
			});
		}
	}

	private _tryCreateStatusItem(): void {
		if (this._statusItem || !this._isUserEnabled()) {
			return;
		}
		// `createChatStatusItem` is gated behind the `chatStatusItem` proposed
		// API which copilot/package.json already enables. We swallow any
		// runtime failure (e.g. older host without the proposal) so the
		// tracker still works for telemetry purposes even without UI.
		try {
			this._statusItem = vscode.window.createChatStatusItem('thecoder.sessionCost');
			this._statusItem.title = vscode.l10n.t('Session cost');
			this._render();
			this._statusItem.show();
		} catch {
			this._statusItem = undefined;
		}
	}

	private _destroyStatusItem(): void {
		try {
			this._statusItem?.dispose();
		} catch { /* host already disposed it */ }
		this._statusItem = undefined;
	}

	private _render(): void {
		if (!this._statusItem) {
			return;
		}
		const currency = this._currencyService.getCurrency();
		const totalLabel = this._currencyService.formatAmount(this._totalUSD, currency);

		this._statusItem.description = `$(symbol-number) ${totalLabel}`;
		this._statusItem.detail = this._byModel.size > 0
			? vscode.l10n.t('{0} request(s) across {1} model(s)', this._totalRequests(), this._byModel.size)
			: vscode.l10n.t('No requests yet this session');
		this._statusItem.tooltip = this._buildTooltip(currency);
	}

	private _totalRequests(): number {
		let n = 0;
		for (const b of this._byModel.values()) {
			n += b.requests;
		}
		return n;
	}

	private _buildTooltip(currency: string): string {
		const lines: string[] = [];
		lines.push(vscode.l10n.t('**Session cost so far**'));
		lines.push('');
		const totalLabel = this._currencyService.formatAmount(this._totalUSD, currency);
		lines.push(vscode.l10n.t('Total: **{0}**', totalLabel));
		lines.push('');
		if (this._byModel.size === 0) {
			lines.push(vscode.l10n.t('_No requests yet._'));
		} else {
			lines.push(vscode.l10n.t('**Per model:**'));
			const entries = Array.from(this._byModel.entries()).sort((a, b) => b[1].costUSD - a[1].costUSD);
			for (const [id, b] of entries) {
				const cost = this._currencyService.formatAmount(b.costUSD, currency);
				lines.push(`• \`${id}\` — ${cost} (${b.requests}× · in ${formatTokens(b.inputTokens)} · cache ${formatTokens(b.cachedTokens)} · out ${formatTokens(b.outputTokens)})`);
			}
		}
		lines.push('');
		lines.push(vscode.l10n.t('Reset via the command palette: `TheCoder: Reset Session Cost`.'));
		return lines.join('\n');
	}

	private _isUserEnabled(): boolean {
		const root = vscode.workspace.getConfiguration('thecoder');
		const sessionCostShow = root.get<boolean>('sessionCost.show', true);
		const pricingShow = root.get<boolean>('pricing.show', true);
		return sessionCostShow && pricingShow;
	}

	private _readCustomRates(): Record<string, ModelPricingUSD> | undefined {
		const raw = vscode.workspace.getConfiguration('thecoder.pricing').get<Record<string, ModelPricingUSD>>('customRates');
		return raw && typeof raw === 'object' ? raw : undefined;
	}
}

function formatTokens(n: number): string {
	if (n < 1000) { return `${n}`; }
	if (n < 1_000_000) { return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`; }
	return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
}

// ---------------------------------------------------------------------------
// Module-level accessor
//
// The tracker is created once in `byokContribution` and exposed here so the
// chat response pipeline (`languageModelAccess.ts`) can record usage without
// needing a new injection point.
// ---------------------------------------------------------------------------

let _instance: SessionCostTracker | undefined;

export function setSessionCostTracker(tracker: SessionCostTracker | undefined): void {
	_instance = tracker;
}

export function getSessionCostTracker(): SessionCostTracker | undefined {
	return _instance;
}
