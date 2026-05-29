/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import {
	buildImageDescriptionUserPrompt,
	extractLastUserTextFromMessages,
	formatImageDescriptionForPrimaryModel,
} from '../imageDescriptionService';

describe('imageDescriptionService helpers', () => {
	it('extracts last user text from messages', () => {
		const messages: Raw.ChatMessage[] = [
			{ role: Raw.ChatRole.Assistant, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'hi' }] },
			{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'fix this UI bug' }] },
		];
		expect(extractLastUserTextFromMessages(messages)).toBe('fix this UI bug');
	});

	it('includes user task context in the vision prompt', () => {
		const prompt = buildImageDescriptionUserPrompt({
			userTaskContext: 'What error is on screen?',
			primaryModelName: 'deepseek-chat',
			attachmentLabel: 'screenshot',
		});
		expect(prompt).toContain('What error is on screen?');
		expect(prompt).toContain('deepseek-chat');
		expect(prompt).toContain('screenshot');
	});

	it('formats description for the primary model', () => {
		const block = formatImageDescriptionForPrimaryModel('A red button labeled Save.', {
			userTaskContext: '',
			primaryModelName: 'deepseek-chat',
		});
		expect(block).toContain('deepseek-chat');
		expect(block).toContain('A red button labeled Save.');
	});
});
