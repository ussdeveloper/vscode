/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { isImageRejectedByApiError, messagesContainImages, stripImagesFromMessages } from '../imageApiRetry';

describe('imageApiRetry', () => {
	it('detects image-related API errors', () => {
		expect(isImageRejectedByApiError('Bad request: image_url is not supported', 400)).toBe(true);
		expect(isImageRejectedByApiError('Request failed', 500)).toBe(false);
	});

	it('strips image parts from messages', () => {
		const messages: Raw.ChatMessage[] = [{
			role: Raw.ChatRole.User,
			content: [
				{ type: Raw.ChatCompletionContentPartKind.Text, text: 'see this' },
				{ type: Raw.ChatCompletionContentPartKind.Image, imageUrl: { url: 'data:image/png;base64,abc' } },
			],
		}];
		expect(messagesContainImages(messages)).toBe(true);
		const stripped = stripImagesFromMessages(messages);
		expect(messagesContainImages(stripped)).toBe(false);
		expect((stripped[0].content as { text: string }[]).some(c => c.text?.includes('omitted'))).toBe(true);
	});
});
