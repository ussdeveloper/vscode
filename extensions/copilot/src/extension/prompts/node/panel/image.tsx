/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import * as l10n from '@vscode/l10n';
import { Image as BaseImage, BasePromptElementProps, ChatResponseReferencePartStatusKind, PromptElement, PromptReference, PromptSizing, TextChunk, UserMessage } from '@vscode/prompt-tsx';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { formatImageDescriptionForPrimaryModel, getImageDescriptionService } from '../../../byok/vscode-node/imageDescriptionService';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { modelCanUseImageURL } from '../../../../platform/endpoint/common/chatModelCapabilities';
import { IImageService } from '../../../../platform/image/common/imageService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { isBYOKModel } from '../../../byok/node/openAIEndpoint';
import { getMimeType } from '../../../../util/common/imageUtils';
import { Uri } from '../../../../vscodeTypes';
import { IPromptEndpoint } from '../base/promptRenderer';
import { Tag } from '../base/tag';

/**
 * Whether pasted/attached images may be embedded in the prompt for this endpoint.
 *
 * Upstream gates images on `copilotToken.isEditorPreviewFeaturesEnabled()`. For
 * TheCoder BYOK (DeepSeek, etc.) there is often no Copilot token — `undefined`
 * would incorrectly block vision even when `supportsVision` is true.
 */
export function canAttachImagesToPromptEndpoint(
	endpoint: IPromptEndpoint,
	authService: IAuthenticationService,
): boolean {
	if (!endpoint.supportsVision) {
		return false;
	}
	if (isBYOKModel(endpoint) > 0) {
		return true;
	}
	return authService.copilotToken?.isEditorPreviewFeaturesEnabled() ?? false;
}

export interface ImageProps extends BasePromptElementProps {
	variableName: string;
	variableValue: Uint8Array | Promise<Uint8Array>;
	omitReferences?: boolean;
	reference?: Uri;
	/** User message text — steers the vision fallback model when describing images. */
	userTaskContext?: string;
}

/**
 * Props for rendering an image that was previously rendered and stored in conversation history.
 * These images are already processed (base64 or URL) and don't need re-uploading.
 */
export interface HistoricalImageProps extends BasePromptElementProps {
	/** The image source - either a base64 string or URL */
	src: string;
	/** The detail level for the image */
	detail?: 'auto' | 'low' | 'high';
	/** The MIME type of the image */
	mimeType?: string;
	userTaskContext?: string;
}

/**
 * Renders an image from conversation history.
 * Checks if the current model supports vision and omits the image if not.
 */
export class HistoricalImage extends PromptElement<HistoricalImageProps, unknown> {
	constructor(
		props: HistoricalImageProps,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
		@IAuthenticationService private readonly authService: IAuthenticationService,
	) {
		super(props);
	}

	override async render(_state: unknown, sizing: PromptSizing) {
		if (canAttachImagesToPromptEndpoint(this.promptEndpoint, this.authService)) {
			return <BaseImage src={this.props.src} detail={this.props.detail} mimeType={this.props.mimeType} />;
		}

		const described = await getImageDescriptionService()?.describeImageFromSrc(
			this.props.src,
			this.props.mimeType,
			{
				userTaskContext: this.props.userTaskContext ?? '',
				primaryModelName: this.promptEndpoint.model,
			},
			CancellationToken.None,
		);
		if (!described) {
			return undefined;
		}

		return (
			<UserMessage priority={0}>
				<Tag name='attachment'>
					<TextChunk>{formatImageDescriptionForPrimaryModel(described.description, {
						userTaskContext: this.props.userTaskContext ?? '',
						primaryModelName: this.promptEndpoint.model,
					})}</TextChunk>
				</Tag>
			</UserMessage>
		);
	}
}

export class Image extends PromptElement<ImageProps, unknown> {
	constructor(
		props: ImageProps,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@IImageService private readonly imageService: IImageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService
	) {
		super(props);
	}

	override async render(_state: unknown, sizing: PromptSizing) {
		const options = { status: { description: l10n.t("{0} does not support images.", this.promptEndpoint.model), kind: ChatResponseReferencePartStatusKind.Omitted } };

		const fillerUri: Uri = this.props.reference ?? Uri.parse('Attached Image');

		try {
			const variable = await this.props.variableValue;
			if (!canAttachImagesToPromptEndpoint(this.promptEndpoint, this.authService)) {
				const described = await getImageDescriptionService()?.describeImageBytes(
					variable,
					getMimeType(Buffer.from(variable).toString('base64')),
					{
						userTaskContext: this.props.userTaskContext ?? '',
						primaryModelName: this.promptEndpoint.model,
						attachmentLabel: this.props.variableName,
					},
					CancellationToken.None,
				);
				if (described) {
					const text = formatImageDescriptionForPrimaryModel(described.description, {
						userTaskContext: this.props.userTaskContext ?? '',
						primaryModelName: this.promptEndpoint.model,
						attachmentLabel: this.props.variableName,
					});
					return (
						<UserMessage priority={0}>
							<Tag name='attachment' attrs={this.props.variableName ? { id: this.props.variableName } : undefined}>
								<TextChunk>
									{!this.props.omitReferences && <references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined)]} />}
									{text}
								</TextChunk>
							</Tag>
						</UserMessage>
					);
				}
				if (this.props.omitReferences) {
					return;
				}

				return (
					<>
						<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined, options)]} />
					</>
				);
			}
			const mimeTypeFromData = getMimeType(Buffer.from(variable).toString('base64'));
			let imageSource = Buffer.from(variable).toString('base64');
			let imageMimeType: string | undefined = mimeTypeFromData;

			const isChatRequest = typeof this.promptEndpoint.urlOrRequestMetadata !== 'string' && (this.promptEndpoint.urlOrRequestMetadata.type === RequestType.ChatCompletions || this.promptEndpoint.urlOrRequestMetadata.type === RequestType.ChatResponses || this.promptEndpoint.urlOrRequestMetadata.type === RequestType.ChatMessages);
			const enabled = this.configurationService.getExperimentBasedConfig(ConfigKey.EnableChatImageUpload, this.experimentationService);
			const useGithubImageUpload = isBYOKModel(this.promptEndpoint) <= 0;
			if (isChatRequest && enabled && useGithubImageUpload && modelCanUseImageURL(this.promptEndpoint)) {
				try {
					const githubToken = (await this.authService.getGitHubSession('any', { silent: true }))?.accessToken;
					const mimeType = getMimeType(imageSource) ?? imageMimeType;
					const uri = await this.imageService.uploadChatImageAttachment(variable, this.props.variableName, mimeType, githubToken);
					if (uri) {
						imageSource = uri.toString();
						imageMimeType = mimeType;
					}
				} catch (error) {
					this.logService.warn(`Image upload failed, using base64 fallback: ${error}`);
				}
			}

			return (
				<UserMessage priority={0}>
					<BaseImage src={imageSource} detail='high' mimeType={imageMimeType} />
					{this.props.reference && (
						<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined)]} />
					)}
				</UserMessage>
			);
		} catch (err) {
			if (this.props.omitReferences) {
				return;
			}

			return (
				<>
					<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined, options)]} />
				</>);
		}
	}
}
