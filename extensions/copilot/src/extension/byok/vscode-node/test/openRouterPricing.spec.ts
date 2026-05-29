/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from 'vitest';

// Mirror the conversion in openRouterProvider.ts (not exported).
const OPENROUTER_USD_PER_TOKEN_TO_PER_MILLION = 1_000_000;

function resolveOpenRouterPricing(pricing: { prompt?: string; completion?: string; input_cache_read?: string } | undefined) {
	if (!pricing) {
		return undefined;
	}
	const inputPerToken = Number(pricing.prompt);
	const outputPerToken = Number(pricing.completion);
	if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) {
		return undefined;
	}
	const cachePerToken = pricing.input_cache_read !== undefined ? Number(pricing.input_cache_read) : undefined;
	return {
		input: inputPerToken * OPENROUTER_USD_PER_TOKEN_TO_PER_MILLION,
		output: outputPerToken * OPENROUTER_USD_PER_TOKEN_TO_PER_MILLION,
		cache: cachePerToken !== undefined && Number.isFinite(cachePerToken)
			? cachePerToken * OPENROUTER_USD_PER_TOKEN_TO_PER_MILLION
			: undefined,
	};
}

test('converts OpenRouter per-token USD to per-1M-token USD', () => {
	const pricing = resolveOpenRouterPricing({
		prompt: '0.00000014',
		completion: '0.00000028',
		input_cache_read: '0.0000000028',
	});
	expect(pricing).toEqual({
		input: 0.14,
		output: 0.28,
		cache: 0.0028,
	});
});
