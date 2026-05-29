/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { OpenAIEndpoint } from '../../../../byok/node/openAIEndpoint';
import { canAttachImagesToPromptEndpoint } from '../image';
import type { IPromptEndpoint } from '../../base/promptRenderer';
import type { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';

describe('canAttachImagesToPromptEndpoint', () => {
	const visionEndpoint = { supportsVision: true } as IPromptEndpoint;

	it('allows BYOK vision models without a Copilot token', () => {
		const endpoint = Object.create(OpenAIEndpoint.prototype) as IPromptEndpoint;
		Object.assign(endpoint, { supportsVision: true });
		const auth = { copilotToken: undefined } as IAuthenticationService;
		expect(canAttachImagesToPromptEndpoint(endpoint, auth)).toBe(true);
	});

	it('blocks when supportsVision is false', () => {
		const auth = { copilotToken: undefined } as IAuthenticationService;
		expect(canAttachImagesToPromptEndpoint({ supportsVision: false } as IPromptEndpoint, auth)).toBe(false);
	});

	it('requires editor preview when not BYOK and token disables preview', () => {
		const auth = {
			copilotToken: { isEditorPreviewFeaturesEnabled: () => false },
		} as unknown as IAuthenticationService;
		expect(canAttachImagesToPromptEndpoint(visionEndpoint, auth)).toBe(false);
	});

	it('allows Copilot vision when preview features are enabled', () => {
		const auth = {
			copilotToken: { isEditorPreviewFeaturesEnabled: () => true },
		} as unknown as IAuthenticationService;
		expect(canAttachImagesToPromptEndpoint(visionEndpoint, auth)).toBe(true);
	});
});
