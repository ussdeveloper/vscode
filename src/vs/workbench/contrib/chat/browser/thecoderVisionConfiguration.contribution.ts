/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from '../common/languageModels.js';
import { createDefaultModelArrays, DefaultModelContribution } from './defaultModelContribution.js';

export const TheCoderVisionConfiguration = {
	UseDescriptionModel: 'thecoder.vision.useDescriptionModel',
	DescriptionModel: 'thecoder.vision.descriptionModel',
} as const;

const defaultEntryLabel = localize('thecoder.vision.descriptionModel.defaultEntry.label', 'Automatic (first vision-capable model)');
const defaultEntryDescription = localize('thecoder.vision.descriptionModel.defaultEntry.description', 'Pick the first available model that supports image input.');

const visionModelArrays = createDefaultModelArrays(defaultEntryLabel, defaultEntryDescription);

/**
 * Populates the dynamic enum for {@link TheCoderVisionConfiguration.DescriptionModel}
 * with vision-capable models currently registered in the app.
 */
export class TheCoderVisionDescriptionModelContribution extends DefaultModelContribution {
	static readonly ID = 'workbench.contrib.thecoderVisionDescriptionModel';

	static readonly modelIds = visionModelArrays.modelIds;
	static readonly modelLabels = visionModelArrays.modelLabels;
	static readonly modelDescriptions = visionModelArrays.modelDescriptions;

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ILogService logService: ILogService,
	) {
		super(visionModelArrays, {
			configKey: TheCoderVisionConfiguration.DescriptionModel,
			configSectionId: 'thecoder',
			logPrefix: '[TheCoderVision]',
			filter: (metadata: ILanguageModelChatMetadata) => !!metadata.capabilities?.vision,
			storageFormat: 'vendorAndId',
			defaultEntryLabel,
			defaultEntryDescription,
		}, languageModelsService, logService);
	}
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	title: localize('thecoder.vision.configurationTitle', 'Image descriptions'),
	id: 'thecoder',
	order: 6,
	properties: {
		[TheCoderVisionConfiguration.UseDescriptionModel]: {
			type: 'boolean',
			order: 50,
			default: true,
			markdownDescription: localize(
				'thecoder.vision.useDescriptionModel',
				'**Describe images for non-vision models** — when enabled, image attachments are sent to a vision-capable model and a text description is injected into the chat model prompt (also used when the API rejects images).',
			),
		},
		[TheCoderVisionConfiguration.DescriptionModel]: {
			type: 'string',
			order: 51,
			default: '',
			description: localize(
				'thecoder.vision.descriptionModel',
				'Vision model used to describe image attachments.',
			),
			enum: TheCoderVisionDescriptionModelContribution.modelIds,
			enumItemLabels: TheCoderVisionDescriptionModelContribution.modelLabels,
			markdownEnumDescriptions: TheCoderVisionDescriptionModelContribution.modelDescriptions,
		},
	},
});

registerWorkbenchContribution2(TheCoderVisionDescriptionModelContribution.ID, TheCoderVisionDescriptionModelContribution, WorkbenchPhase.BlockRestore);
