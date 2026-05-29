/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isDeepSeekReasonerId, resolveDeepSeekModelCapabilities } from '../deepseekProvider';

const humanize = (id: string) => id;

describe('resolveDeepSeekModelCapabilities', () => {
	it('enables vision on chat and V4 flash/pro models', () => {
		for (const id of ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
			const caps = resolveDeepSeekModelCapabilities(id, humanize);
			expect(caps?.vision).toBe(true);
			expect(caps?.toolCalling).toBe(true);
		}
	});

	it('disables vision and tools on reasoner models', () => {
		const caps = resolveDeepSeekModelCapabilities('deepseek-reasoner', humanize);
		expect(caps?.vision).toBe(false);
		expect(caps?.toolCalling).toBe(false);
		expect(caps?.thinking).toBe(true);
	});

	it('uses 1M context for V4 family', () => {
		const caps = resolveDeepSeekModelCapabilities('deepseek-v4-flash', humanize);
		expect(caps?.maxInputTokens).toBe(1_000_000 - 8_192);
	});
});

describe('isDeepSeekReasonerId', () => {
	it('matches reasoner and R1 ids', () => {
		expect(isDeepSeekReasonerId('deepseek-reasoner')).toBe(true);
		expect(isDeepSeekReasonerId('deepseek-r1-distill')).toBe(true);
		expect(isDeepSeekReasonerId('deepseek-v4-flash')).toBe(false);
	});
});
