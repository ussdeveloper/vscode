/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChat, LanguageModelChatMessage, LanguageModelDataPart, LanguageModelTextPart, lm, workspace } from 'vscode';
import { ChatImageMimeType } from '../../conversation/common/languageModelChatMessageHelpers';
import { messagesContainImages, OMITTED_IMAGE_PLACEHOLDER } from '../../prompt/common/imageApiRetry';
import { ILogService } from '../../../platform/log/common/logService';
import { getMimeType } from '../../../util/common/imageUtils';
import { MarkdownString } from '../../../vscodeTypes';

export const VISION_CONFIG_NS = 'thecoder.vision';

const IMAGE_DESCRIBE_NOTICE_COLOR = '#3498db';

export interface ImageDescriptionContext {
	/** Latest user message / task — steers what the vision model should emphasize. */
	readonly userTaskContext: string;
	/** Chat model that will receive the text description instead of the image. */
	readonly primaryModelName: string;
	/** Optional attachment id / variable name for disambiguation. */
	readonly attachmentLabel?: string;
}

export interface ReplaceImagesResult {
	readonly messages: Raw.ChatMessage[];
	readonly describedCount: number;
	readonly descriptionModelLabel?: string;
}

export function readVisionFallbackSettings(): { enabled: boolean; modelSpec: string } {
	const cfg = workspace.getConfiguration(VISION_CONFIG_NS);
	return {
		enabled: cfg.get<boolean>('useDescriptionModel', true),
		modelSpec: (cfg.get<string>('descriptionModel', '') ?? '').trim(),
	};
}

/**
 * Last user-role text in the message list (used to steer the vision model).
 */
export function extractLastUserTextFromMessages(messages: readonly Raw.ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== Raw.ChatRole.User) {
			continue;
		}
		if (typeof m.content === 'string') {
			const t = m.content.trim();
			if (t) {
				return t;
			}
			continue;
		}
		if (Array.isArray(m.content)) {
			const texts = m.content
				.filter(c => c.type === Raw.ChatCompletionContentPartKind.Text)
				.map(c => (c as { text: string }).text);
			const joined = texts.join('\n').trim();
			if (joined) {
				return joined;
			}
		}
	}
	return '';
}

export function buildImageDescriptionUserPrompt(ctx: ImageDescriptionContext): string {
	const task = ctx.userTaskContext.trim()
		|| '(no user message text is available yet — describe the image so a coding assistant can help with what the user likely needs)';
	const label = ctx.attachmentLabel ? `\nAttachment id: ${ctx.attachmentLabel}` : '';
	return `You help another AI model (**${ctx.primaryModelName}**) that cannot receive images directly.

The user's message / task context:
---
${task}
---${label}

Describe the attached image so the other model can complete the user's task WITHOUT seeing the image. Include:
- Main subjects, layout, and visible UI (windows, panels, buttons) when relevant
- All readable text (OCR): labels, errors, stack traces, code snippets, numbers
- Colors or styling only when they matter for the task
- What the user likely cares about given their message

Write in the same language the user used when possible. Be factual and complete but concise. Do not say you cannot see the image.`;
}

export function formatImageDescriptionForPrimaryModel(description: string, ctx: ImageDescriptionContext): string {
	const label = ctx.attachmentLabel ? ` (${ctx.attachmentLabel})` : '';
	return `[TheCoder — image description for ${ctx.primaryModelName}]${label}\nThe user attached an image. Use this description (the target model cannot see the image):\n\n${description.trim()}`;
}

export function buildImageDescribedViaProxyNotice(modelLabel: string): MarkdownString {
	const md = new MarkdownString(
		`<span style="color:${IMAGE_DESCRIBE_NOTICE_COLOR}">$(eye) Image described via ${modelLabel}</span>`,
		{ supportThemeIcons: true },
	);
	md.supportHtml = true;
	return md;
}

function isImageContentPart(c: Raw.ChatCompletionContentPart): boolean {
	return c.type === Raw.ChatCompletionContentPartKind.Image
		|| ('image_url' in c && !!(c as { image_url?: unknown }).image_url)
		|| ('imageUrl' in c && !!(c as { imageUrl?: unknown }).imageUrl);
}

function parseImageBytesFromPart(part: Raw.ChatCompletionContentPart): { bytes: Uint8Array; mimeType: string } | undefined {
	const url = (part as { imageUrl?: { url: string } }).imageUrl?.url
		?? (part as { image_url?: { url: string } }).image_url?.url;
	if (!url?.startsWith('data:')) {
		return undefined;
	}
	const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
	if (!match) {
		return undefined;
	}
	const [, mimeType, base64] = match;
	return { bytes: Buffer.from(base64, 'base64'), mimeType };
}

function modelLabel(model: LanguageModelChat): string {
	return `${model.vendor}/${model.id}`;
}

export class ImageDescriptionService implements vscode.Disposable {
	constructor(private readonly _logService: ILogService) { }

	dispose(): void { }

	isEnabled(): boolean {
		return readVisionFallbackSettings().enabled;
	}

	async resolveDescriptionModel(): Promise<LanguageModelChat | undefined> {
		const { modelSpec } = readVisionFallbackSettings();
		if (modelSpec) {
			const slash = modelSpec.indexOf('/');
			if (slash > 0 && slash < modelSpec.length - 1) {
				const vendor = modelSpec.substring(0, slash);
				const id = modelSpec.substring(slash + 1);
				try {
					const models = await lm.selectChatModels({ vendor, id });
					const vision = models.filter(m => m.capabilities?.imageInput);
					if (vision.length === 1) {
						return vision[0];
					}
					if (vision.length > 1) {
						this._logService.warn(`[ImageDescriptionService] ${modelSpec} matched ${vision.length} vision models; using the first.`);
						return vision[0];
					}
					this._logService.warn(`[ImageDescriptionService] Configured description model '${modelSpec}' has no imageInput capability.`);
				} catch (err) {
					this._logService.warn(`[ImageDescriptionService] Failed to resolve '${modelSpec}': ${err}`);
				}
			} else {
				this._logService.warn(`[ImageDescriptionService] Ignoring malformed thecoder.vision.descriptionModel: '${modelSpec}' (expected vendor/id).`);
			}
		}

		const hideCopilot = workspace.getConfiguration('thecoder').get<boolean>('hideCopilotModels', true);
		try {
			const all = await lm.selectChatModels({});
			return all.find(m => m.capabilities?.imageInput && (!hideCopilot || m.vendor !== 'copilot'));
		} catch (err) {
			this._logService.warn(`[ImageDescriptionService] Failed to list chat models for auto-pick: ${err}`);
			return undefined;
		}
	}

	async describeImageBytes(
		bytes: Uint8Array,
		mimeType: string | undefined,
		ctx: ImageDescriptionContext,
		token: CancellationToken,
	): Promise<{ description: string; modelLabel: string } | undefined> {
		if (!this.isEnabled()) {
			return undefined;
		}
		const model = await this.resolveDescriptionModel();
		if (!model) {
			return undefined;
		}

		const resolvedMime = mimeType ?? getMimeType(Buffer.from(bytes).toString('base64')) ?? ChatImageMimeType.PNG;
		const promptText = buildImageDescriptionUserPrompt(ctx);

		try {
			const messages = [
				LanguageModelChatMessage.User([
					new LanguageModelTextPart(promptText),
					LanguageModelDataPart.image(bytes, resolvedMime as ChatImageMimeType),
				]),
			];
			const response = await model.sendRequest(messages, {}, token);
			let text = '';
			for await (const chunk of response.stream) {
				if (token.isCancellationRequested) {
					return undefined;
				}
				if (chunk instanceof LanguageModelTextPart) {
					text += chunk.value;
				}
			}
			text = text.trim();
			if (!text) {
				this._logService.warn(`[ImageDescriptionService] Empty description from ${modelLabel(model)}`);
				return undefined;
			}
			return { description: text, modelLabel: modelLabel(model) };
		} catch (err) {
			this._logService.warn(`[ImageDescriptionService] describe failed (${modelLabel(model)}): ${err}`);
			return undefined;
		}
	}

	async describeImageFromSrc(
		src: string,
		mimeType: string | undefined,
		ctx: ImageDescriptionContext,
		token: CancellationToken,
	): Promise<{ description: string; modelLabel: string } | undefined> {
		if (src.startsWith('data:')) {
			const parsed = parseImageBytesFromPart({
				type: Raw.ChatCompletionContentPartKind.Image,
				imageUrl: { url: src },
			} as Raw.ChatCompletionContentPart);
			if (parsed) {
				return this.describeImageBytes(parsed.bytes, parsed.mimeType, ctx, token);
			}
		}
		if (!src.startsWith('http')) {
			try {
				const bytes = Buffer.from(src, 'base64');
				return this.describeImageBytes(bytes, mimeType, ctx, token);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	async replaceImagesInMessages(
		messages: readonly Raw.ChatMessage[],
		ctx: ImageDescriptionContext,
		token: CancellationToken,
	): Promise<ReplaceImagesResult> {
		if (!this.isEnabled() || !messagesContainImages(messages)) {
			return { messages: [...messages], describedCount: 0 };
		}

		const cache = new Map<string, string>();
		let describedCount = 0;
		let descriptionModelLabel: string | undefined;

		const out = await Promise.all(messages.map(async m => {
			if (!Array.isArray(m.content)) {
				return { ...m };
			}
			const newContent: Raw.ChatCompletionContentPart[] = [];
			let imageIndex = 0;
			for (const part of m.content) {
				if (!isImageContentPart(part)) {
					newContent.push(part);
					continue;
				}
				imageIndex++;
				const parsed = parseImageBytesFromPart(part);
				if (!parsed) {
					newContent.push({ type: Raw.ChatCompletionContentPartKind.Text, text: OMITTED_IMAGE_PLACEHOLDER });
					continue;
				}
				const cacheKey = parsed.bytes.byteLength + ':' + parsed.mimeType + ':' + Buffer.from(parsed.bytes).toString('base64').slice(0, 48);
				let description = cache.get(cacheKey);
				if (!description) {
					const partCtx: ImageDescriptionContext = {
						...ctx,
						userTaskContext: ctx.userTaskContext || extractLastUserTextFromMessages(messages),
						attachmentLabel: ctx.attachmentLabel ?? (imageIndex > 1 ? `image-${imageIndex}` : undefined),
					};
					const result = await this.describeImageBytes(parsed.bytes, parsed.mimeType, partCtx, token);
					if (result) {
						description = result.description;
						descriptionModelLabel = result.modelLabel;
						cache.set(cacheKey, description);
						describedCount++;
					}
				} else {
					describedCount++;
				}
				if (description) {
					newContent.push({
						type: Raw.ChatCompletionContentPartKind.Text,
						text: formatImageDescriptionForPrimaryModel(description, {
							...ctx,
							attachmentLabel: ctx.attachmentLabel ?? (imageIndex > 1 ? `image-${imageIndex}` : undefined),
						}),
					});
				} else {
					newContent.push({ type: Raw.ChatCompletionContentPartKind.Text, text: OMITTED_IMAGE_PLACEHOLDER });
				}
			}
			if (newContent.length === 0) {
				return { ...m, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: OMITTED_IMAGE_PLACEHOLDER }] };
			}
			return { ...m, content: newContent };
		}));

		return { messages: out, describedCount, descriptionModelLabel };
	}
}

let _service: ImageDescriptionService | undefined;

export function setImageDescriptionService(service: ImageDescriptionService | undefined): void {
	_service = service;
}

export function getImageDescriptionService(): ImageDescriptionService | undefined {
	return _service;
}
