/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-million-token list prices for popular BYOK models. Values are quoted in
 * USD as published by each provider on their pricing pages.
 *
 * The pricing database is intentionally pattern-based (the lookup uses a
 * normalised model id with vendor prefixes stripped) so a single entry can
 * cover snapshots, dated revisions, and provider-prefixed variants
 * (e.g. `anthropic/claude-sonnet-4` on OpenRouter).
 *
 * Sources (last refreshed 2026-05):
 * - DeepSeek:    https://api-docs.deepseek.com/quick_start/pricing
 * - OpenAI:      https://openai.com/api/pricing
 * - Anthropic:   https://www.anthropic.com/pricing
 * - Google:      https://ai.google.dev/gemini-api/docs/pricing
 * - xAI:         https://docs.x.ai/docs/models
 * - Mistral:     https://mistral.ai/technology/#pricing
 *
 * If a model is missing here we simply don't show pricing; the picker degrades
 * gracefully. Users can add their own entries via
 * `thecoder.pricing.customRates` in settings.
 */

export interface ModelPricingUSD {
	/** USD per 1M input tokens (uncached prompt). */
	readonly input: number;
	/** USD per 1M output tokens. */
	readonly output: number;
	/** USD per 1M cached input tokens (when the provider supports caching). */
	readonly cache?: number;
}

const RESOLVED_MODEL_PRICING = new Map<string, ModelPricingUSD>();

function makePricingKey(providerName: string | undefined, modelId: string): string {
	const providerPart = providerName?.trim().toLowerCase();
	const modelPart = modelId.trim().toLowerCase();
	return providerPart ? `${providerPart}/${modelPart}` : modelPart;
}

/**
 * Map of canonical model-id prefix → pricing. The lookup matches the longest
 * key that the model id starts with after normalisation, so generic families
 * (`gpt-4o`) can be overridden by specific snapshots (`gpt-4o-2024-11-20`)
 * just by ordering keys long-first.
 */
const BUILTIN_PRICING: Record<string, ModelPricingUSD> = {
	// --- DeepSeek (https://api-docs.deepseek.com/quick_start/pricing) -------
	// `deepseek-v4-flash` is the current production model; `deepseek-chat`
	// and `deepseek-reasoner` are deprecated aliases that route to V4 Flash
	// in non-thinking and thinking mode respectively.
	'deepseek-v4-flash': { input: 0.14, cache: 0.0028, output: 0.28 },
	'deepseek-v4-pro': { input: 0.435, cache: 0.003625, output: 0.87 },
	'deepseek-v4': { input: 0.14, cache: 0.0028, output: 0.28 },
	'deepseek-chat': { input: 0.14, cache: 0.0028, output: 0.28 },
	'deepseek-coder': { input: 0.14, cache: 0.0028, output: 0.28 },
	'deepseek-reasoner': { input: 0.14, cache: 0.0028, output: 0.28 },
	'deepseek-r1': { input: 0.55, cache: 0.14, output: 2.19 },
	'deepseek-v3.2': { input: 0.27, cache: 0.07, output: 1.10 },
	'deepseek-v3': { input: 0.27, cache: 0.07, output: 1.10 },

	// --- OpenAI -------------------------------------------------------------
	'gpt-5.5': { input: 1.25, cache: 0.13, output: 10.00 },
	'gpt-5.4': { input: 1.25, cache: 0.13, output: 10.00 },
	'gpt-5.4-mini': { input: 0.25, cache: 0.03, output: 2.00 },
	'gpt-5.4-nano': { input: 0.05, cache: 0.01, output: 0.40 },
	'gpt-5.3': { input: 1.25, cache: 0.13, output: 10.00 },
	'gpt-5': { input: 1.25, cache: 0.13, output: 10.00 },
	'gpt-4.1': { input: 2.00, cache: 0.50, output: 8.00 },
	'gpt-4o-mini': { input: 0.15, cache: 0.075, output: 0.60 },
	'gpt-4o': { input: 2.50, cache: 1.25, output: 10.00 },
	'o3-mini': { input: 1.10, cache: 0.55, output: 4.40 },
	'o3': { input: 2.00, cache: 0.50, output: 8.00 },
	'o1-mini': { input: 1.10, cache: 0.55, output: 4.40 },
	'o1-preview': { input: 15.00, cache: 7.50, output: 60.00 },
	'o1': { input: 15.00, cache: 7.50, output: 60.00 },

	// --- Anthropic (Claude) -------------------------------------------------
	'claude-opus-4': { input: 15.00, cache: 1.50, output: 75.00 },
	'claude-sonnet-4-7': { input: 3.00, cache: 0.30, output: 15.00 },
	'claude-sonnet-4': { input: 3.00, cache: 0.30, output: 15.00 },
	'claude-haiku-4': { input: 0.80, cache: 0.08, output: 4.00 },
	'claude-haiku-3.5': { input: 0.80, cache: 0.08, output: 4.00 },
	'claude-3-5-sonnet': { input: 3.00, cache: 0.30, output: 15.00 },
	'claude-3-5-haiku': { input: 0.80, cache: 0.08, output: 4.00 },
	'claude-3-opus': { input: 15.00, cache: 1.50, output: 75.00 },

	// --- Google Gemini ------------------------------------------------------
	'gemini-3.5-pro': { input: 1.25, cache: 0.31, output: 10.00 },
	'gemini-3.5-flash': { input: 0.10, cache: 0.025, output: 0.40 },
	'gemini-2.5-pro': { input: 1.25, cache: 0.31, output: 10.00 },
	'gemini-2.5-flash': { input: 0.075, cache: 0.019, output: 0.30 },
	'gemini-2.0-flash': { input: 0.10, cache: 0.025, output: 0.40 },
	'gemini-1.5-pro': { input: 1.25, cache: 0.31, output: 5.00 },
	'gemini-1.5-flash': { input: 0.075, cache: 0.019, output: 0.30 },

	// --- xAI Grok -----------------------------------------------------------
	'grok-4': { input: 3.00, output: 15.00 },
	'grok-3': { input: 3.00, output: 15.00 },
	'grok-2': { input: 2.00, output: 10.00 },
	'grok-beta': { input: 5.00, output: 15.00 },
	'grok-code-fast': { input: 0.20, output: 1.50 },

	// --- Mistral ------------------------------------------------------------
	'mistral-large': { input: 2.00, output: 6.00 },
	'mistral-medium': { input: 0.40, output: 2.00 },
	'mistral-small': { input: 0.20, output: 0.60 },
	'codestral': { input: 0.20, output: 0.60 },

	// --- Meta Llama (via OpenRouter / TogetherAI typical) -------------------
	'llama-3.3-70b': { input: 0.59, output: 0.79 },
	'llama-3.1-405b': { input: 2.70, output: 2.70 },
	'llama-3.1-70b': { input: 0.59, output: 0.79 },
	'llama-3.1-8b': { input: 0.18, output: 0.18 },

	// --- Qwen ---------------------------------------------------------------
	'qwen-coder-plus': { input: 0.20, output: 0.60 },
	'qwen-max': { input: 1.60, output: 6.40 },
	'qwen-plus': { input: 0.40, output: 1.20 },
};

const PROVIDER_PREFIXES_TO_STRIP: readonly string[] = [
	'openai/',
	'anthropic/',
	'google/',
	'google-vertex/',
	'deepseek/',
	'mistralai/',
	'meta-llama/',
	'meta/',
	'xai/',
	'x-ai/',
	'qwen/',
	'alibaba/',
];

function normaliseModelId(modelId: string): string {
	let id = modelId.toLowerCase().trim();
	for (const prefix of PROVIDER_PREFIXES_TO_STRIP) {
		if (id.startsWith(prefix)) {
			id = id.slice(prefix.length);
			break;
		}
	}
	// Strip trailing date snapshots: gpt-4o-2024-11-20 → gpt-4o
	// (only when the suffix looks like a YYYY-MM-DD or YYYYMMDD revision)
	id = id.replace(/-(20\d{2}[-]?\d{2}[-]?\d{2}|preview|exp)$/i, '');
	return id;
}

let sortedKeysCache: string[] | undefined;
function getSortedPricingKeys(): string[] {
	if (!sortedKeysCache) {
		sortedKeysCache = Object.keys(BUILTIN_PRICING).sort((a, b) => b.length - a.length);
	}
	return sortedKeysCache;
}

/**
 * Look up published USD pricing for a model. Returns `undefined` if we do not
 * have data for that model id; the caller is expected to fall back to the
 * provider's own metadata or to hide the cost UI.
 */
export function rememberModelPricing(providerName: string | undefined, modelId: string, pricing: ModelPricingUSD | undefined): void {
	if (!pricing) {
		return;
	}
	RESOLVED_MODEL_PRICING.set(makePricingKey(providerName, modelId), pricing);
}

/** Drop cached provider/API pricing so the next model resolve refetches rates. */
export function clearResolvedModelPricing(): void {
	RESOLVED_MODEL_PRICING.clear();
}

export function getModelPricingUSD(modelId: string, customRates?: Record<string, ModelPricingUSD>, providerName?: string): ModelPricingUSD | undefined {
	const id = normaliseModelId(modelId);
	const providerKey = makePricingKey(providerName, id);

	// User overrides win against the builtin table. They are matched against the
	// raw model id first (so a user can target `anthropic/claude-sonnet-4`
	// specifically on OpenRouter) and then against the normalised id.
	if (customRates) {
		const providerHit = customRates[providerKey];
		if (providerHit) {
			return providerHit;
		}
		const rawHit = customRates[modelId] ?? customRates[modelId.toLowerCase()];
		if (rawHit) {
			return rawHit;
		}
		const normHit = customRates[id];
		if (normHit) {
			return normHit;
		}
	}

	const resolvedHit = RESOLVED_MODEL_PRICING.get(providerKey);
	if (resolvedHit) {
		return resolvedHit;
	}

	for (const key of getSortedPricingKeys()) {
		if (id === key || id.startsWith(key + '-') || id.startsWith(key + '_')) {
			return BUILTIN_PRICING[key];
		}
	}
	return undefined;
}

/**
 * Return the full builtin pricing map. Exposed mainly for diagnostics and
 * tests; runtime callers should prefer {@link getModelPricingUSD}.
 */
export function getBuiltinPricingTable(): Readonly<Record<string, ModelPricingUSD>> {
	return BUILTIN_PRICING;
}

// ---------------------------------------------------------------------------
// Pricing decorator wiring
//
// The pricing decorator is a thin module-level seam between the BYOK provider
// layer (which builds `LanguageModelChatInformation` rows) and the workbench
// (which renders them in the model picker). We deliberately avoid threading a
// `currencyService` argument through every BYOK call-site — most providers
// already have unique constructor signatures shared with upstream Microsoft,
// and TheCoder's pricing UI is a clear-cut cross-cutting concern that's best
// configured once at extension activation.
//
// The contract is:
//   - At extension activation, BYOKContrib calls `setPricingDecoratorContext`
//     with a live CurrencyService and a (possibly empty) user-overrides map.
//   - `byokKnownModelToAPIInfo` calls `decorateModelInfoWithPricing` on every
//     row it returns. The decorator is a no-op until the context is set or
//     when the user disables pricing via `thecoder.pricing.show: false`.
// ---------------------------------------------------------------------------

interface PricingDecoratorContext {
	readonly getCurrency: () => string;
	readonly getSymbol: (currency?: string) => string;
	readonly convertFromUSD: (amount: number, currency?: string) => number;
	readonly formatPerMillion: (usdPerMillion: number, currency?: string) => string;
	readonly isEnabled: () => boolean;
	readonly getCustomRates: () => Record<string, ModelPricingUSD> | undefined;
}

let _ctx: PricingDecoratorContext | undefined;

export function setPricingDecoratorContext(ctx: PricingDecoratorContext | undefined): void {
	_ctx = ctx;
}

/**
 * Per-model pricing metadata fields recognised by VS Code's model picker.
 * Kept loose so callers do not need to import the `vscode` types from common
 * code (this file is shared between Node and browser contexts).
 */
export interface PricingMetadataFields {
	pricing?: string;
	inputCost?: number;
	outputCost?: number;
	cacheCost?: number;
	priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
	tooltip?: string;
}

/**
 * Compute the price-display fields for a model. Returns `undefined` when
 * pricing is disabled by the user or when we have no pricing data for this
 * model. The returned record is intended to be spread on top of the
 * provider-built `LanguageModelChatInformation`.
 *
 * `existingTooltip` lets callers preserve and extend any tooltip the provider
 * has already set (e.g. "Contributed via DeepSeek provider").
 */
export function decorateModelInfoWithPricing(modelId: string, existingTooltip?: string, providerName?: string, explicitPricing?: ModelPricingUSD): PricingMetadataFields | undefined {
	if (!_ctx || !_ctx.isEnabled()) {
		if (explicitPricing) {
			return undefined;
		}
		return undefined;
	}
	const pricing = explicitPricing ?? getModelPricingUSD(modelId, _ctx.getCustomRates(), providerName);
	if (!pricing) {
		return undefined;
	}
	rememberModelPricing(providerName, modelId, pricing);
	const currency = _ctx.getCurrency();
	const inputDisplay = _ctx.formatPerMillion(pricing.input, currency);
	const outputDisplay = _ctx.formatPerMillion(pricing.output, currency);
	const cacheDisplay = pricing.cache !== undefined ? _ctx.formatPerMillion(pricing.cache, currency) : undefined;

	// Short summary used in the picker label / `pricing` slot.
	// Matches the user-requested visual shape `${input}/${output}` per 1M.
	const summary = `${inputDisplay} / ${outputDisplay}`;

	// Numeric values are converted to the user's currency so downstream UI
	// (e.g. the dedicated cost section that VS Code renders for UBB users)
	// shows numbers in the same units as the picker label.
	const inputCost = _ctx.convertFromUSD(pricing.input, currency);
	const outputCost = _ctx.convertFromUSD(pricing.output, currency);
	const cacheCost = pricing.cache !== undefined ? _ctx.convertFromUSD(pricing.cache, currency) : undefined;

	// Relative cost bucket — purely visual, used by the picker to colour the
	// pill badge. Thresholds are based on the USD list price so the category
	// stays stable across currencies.
	const priceCategory = pricing.output >= 30
		? 'very_high'
		: pricing.output >= 8
			? 'high'
			: pricing.output >= 1
				? 'medium'
				: 'low';

	const tooltipLines: string[] = [];
	if (existingTooltip) {
		tooltipLines.push(existingTooltip);
		tooltipLines.push('');
	}
	tooltipLines.push(`**Cost (per 1M tokens):**`);
	tooltipLines.push(`• Input: ${inputDisplay}`);
	if (cacheDisplay !== undefined) {
		tooltipLines.push(`• Cached input: ${cacheDisplay}`);
	}
	tooltipLines.push(`• Output: ${outputDisplay}`);

	return {
		pricing: summary,
		inputCost,
		outputCost,
		cacheCost,
		priceCategory,
		tooltip: tooltipLines.join('\n'),
	};
}
