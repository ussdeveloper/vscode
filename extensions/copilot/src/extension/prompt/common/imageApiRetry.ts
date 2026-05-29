/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ChatFetchError, ChatFetchResponseType, ChatResponses } from '../../../platform/chat/common/commonTypes';
import { MarkdownString } from '../../../vscodeTypes';

const IMAGE_REJECT_NOTICE_COLOR = '#e67e22';

const IMAGE_REJECTION_KEYWORDS = [
	'image_url',
	'image url',
	'image input',
	'image content',
	'image/png',
	'image/jpeg',
	'image/webp',
	'vision',
	'multimodal',
	'does not support image',
	'not support image',
	'unsupported image',
	'invalid image',
	'cannot process image',
	"can't process image",
];

/**
 * Heuristic: provider rejected the request because of image/vision content.
 */
export function isImageRejectedByApiError(reason: string, statusCode?: number): boolean {
	const lower = reason.toLowerCase();
	if (!IMAGE_REJECTION_KEYWORDS.some(k => lower.includes(k))) {
		return false;
	}
	if (statusCode !== undefined && [400, 415, 422].includes(statusCode)) {
		return true;
	}
	return lower.includes('bad request')
		|| lower.includes('invalid')
		|| lower.includes('unsupported')
		|| lower.includes('not support');
}

export function isImageRejectedByApiFetchResult(fetchResult: ChatFetchError, statusCode?: number): boolean {
	switch (fetchResult.type) {
		case ChatFetchResponseType.BadRequest:
		case ChatFetchResponseType.Failed:
			return isImageRejectedByApiError(fetchResult.reason, statusCode);
		default:
			return false;
	}
}

export function messagesContainImages(messages: readonly Raw.ChatMessage[]): boolean {
	return messages.some(m => {
		if (!Array.isArray(m.content)) {
			return false;
		}
		return m.content.some(c =>
			c.type === Raw.ChatCompletionContentPartKind.Image
			|| ('image_url' in c && !!(c as { image_url?: unknown }).image_url)
			|| ('imageUrl' in c && !!(c as { imageUrl?: unknown }).imageUrl)
		);
	});
}

/**
 * Remove image parts from chat messages so the provider can accept the request.
 */
export const OMITTED_IMAGE_PLACEHOLDER = '[Image attachment omitted — not supported by this model API.]';

export function stripImagesFromMessages(messages: readonly Raw.ChatMessage[]): Raw.ChatMessage[] {
	const placeholder = OMITTED_IMAGE_PLACEHOLDER;
	return messages.map(m => {
		if (!Array.isArray(m.content)) {
			return { ...m };
		}
		const filtered = m.content.filter(c =>
			c.type !== Raw.ChatCompletionContentPartKind.Image
			&& !('image_url' in c)
			&& !('imageUrl' in c)
		);
		if (filtered.length === 0) {
			return { ...m, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: placeholder }] };
		}
		const hadImage = filtered.length < m.content.length;
		if (!hadImage) {
			return { ...m };
		}
		const textParts = filtered.filter(c => c.type === Raw.ChatCompletionContentPartKind.Text);
		const nonText = filtered.filter(c => c.type !== Raw.ChatCompletionContentPartKind.Text);
		const mergedText = textParts.map(c => (c as { text: string }).text).join('\n').trim();
		const note = mergedText ? `${mergedText}\n\n${placeholder}` : placeholder;
		return { ...m, content: [...nonText, { type: Raw.ChatCompletionContentPartKind.Text, text: note }] };
	});
}

export function buildImageIgnoredByApiNotice(): MarkdownString {
	const md = new MarkdownString(
		`<span style="color:${IMAGE_REJECT_NOTICE_COLOR}">$(warning) Image Ignored By API</span>`,
		{ supportThemeIcons: true },
	);
	md.supportHtml = true;
	return md;
}

export function emptySuccessAfterImageIgnored(requestId: string, serverRequestId: string | undefined, resolvedModel = ''): ChatResponses {
	return {
		type: ChatFetchResponseType.Success,
		value: [''],
		requestId,
		serverRequestId,
		resolvedModel,
		usage: undefined,
		imageIgnoredByApi: true,
	};
}
