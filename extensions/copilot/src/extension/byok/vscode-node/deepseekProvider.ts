/*---------------------------------------------------------------------------------------------

 *  Copyright (c) Microsoft Corporation. All rights reserved.

 *  Licensed under the MIT License. See License.txt in the project root for license information.

 *--------------------------------------------------------------------------------------------*/

import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';

import { IDomainService } from '../../../platform/endpoint/common/domainService';

import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';

import { ILogService } from '../../../platform/log/common/logService';

import { IFetcherService } from '../../../platform/networking/common/fetcherService';

import { IEndpointBody } from '../../../platform/networking/common/networking';

import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';

import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';

import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';

import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';

import { OpenAIEndpoint } from '../node/openAIEndpoint';

import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';

import { IBYOKStorageService } from './byokStorageService';



// Shape of an item returned by https://api.deepseek.com/v1/models

// See https://api-docs.deepseek.com/api/list-models

interface DeepSeekModelData {

	id: string;

	object: string;

	owned_by?: string;

}



/** V4 API default context (1M tokens). Reserve headroom for output. */

const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 8_192;

const DEEPSEEK_V4_MAX_INPUT_TOKENS = 1_000_000 - DEEPSEEK_V4_MAX_OUTPUT_TOKENS;



/** Legacy V3-era window kept for unknown/custom DeepSeek model ids. */

const DEEPSEEK_LEGACY_MAX_OUTPUT_TOKENS = 8_192;

const DEEPSEEK_LEGACY_MAX_INPUT_TOKENS = 128_000 - DEEPSEEK_LEGACY_MAX_OUTPUT_TOKENS;



/**

 * Pre-seeded capabilities for models returned by `GET /v1/models`.

 * Discovery merges these before {@link resolveDeepSeekModelCapabilities}.

 */

export const DEEPSEEK_KNOWN_MODELS: BYOKKnownModels = {

	'deepseek-chat': {

		name: 'DeepSeek Chat (V4 Flash)',

		toolCalling: true,

		vision: true,

		maxInputTokens: DEEPSEEK_V4_MAX_INPUT_TOKENS,

		maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,

	},

	'deepseek-v4-flash': {

		name: 'DeepSeek V4 Flash',

		toolCalling: true,

		vision: true,

		maxInputTokens: DEEPSEEK_V4_MAX_INPUT_TOKENS,

		maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,

	},

	'deepseek-v4-pro': {

		name: 'DeepSeek V4 Pro',

		toolCalling: true,

		vision: true,

		maxInputTokens: DEEPSEEK_V4_MAX_INPUT_TOKENS,

		maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,

	},

	'deepseek-reasoner': {

		name: 'DeepSeek Reasoner (V4 Flash thinking)',

		toolCalling: false,

		vision: false,

		thinking: true,

		maxInputTokens: DEEPSEEK_V4_MAX_INPUT_TOKENS,

		maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,

		supportsReasoningEffort: ['low', 'medium', 'high', 'max'],

		reasoningEffortFormat: 'chat-completions',

	},

};



export function isDeepSeekReasonerId(modelId: string): boolean {

	const id = modelId.toLowerCase();

	return id === 'deepseek-reasoner'

		|| id.startsWith('deepseek-r1')

		|| id.includes('reasoner');

}



/** Models that should not be offered as chat endpoints. */

function isDeepSeekNonChatId(modelId: string): boolean {

	const id = modelId.toLowerCase();

	return id.includes('embed');

}



/** V4 family and general chat models (OpenAI-style `image_url` parts). */

function isDeepSeekVisionCapableId(modelId: string): boolean {

	if (isDeepSeekReasonerId(modelId) || isDeepSeekNonChatId(modelId)) {

		return false;

	}

	const id = modelId.toLowerCase();

	return id === 'deepseek-chat'

		|| id === 'deepseek-v4-flash'

		|| id === 'deepseek-v4-pro'

		|| id.startsWith('deepseek-v4-')

		|| id.includes('-vl')

		|| id.includes('vision')

		|| (id.startsWith('deepseek-') && !id.includes('reasoner') && !id.startsWith('deepseek-r'));

}



function isDeepSeekV4FamilyId(modelId: string): boolean {

	const id = modelId.toLowerCase();

	return id === 'deepseek-chat'

		|| id === 'deepseek-reasoner'

		|| id.startsWith('deepseek-v4-');

}



export function resolveDeepSeekModelCapabilities(modelId: string, humanize: (id: string) => string): BYOKModelCapabilities | undefined {

	if (!modelId || isDeepSeekNonChatId(modelId)) {

		return undefined;

	}



	const limits = isDeepSeekV4FamilyId(modelId)

		? { maxInputTokens: DEEPSEEK_V4_MAX_INPUT_TOKENS, maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS }

		: { maxInputTokens: DEEPSEEK_LEGACY_MAX_INPUT_TOKENS, maxOutputTokens: DEEPSEEK_LEGACY_MAX_OUTPUT_TOKENS };



	if (isDeepSeekReasonerId(modelId)) {

		return {

			name: humanize(modelId),

			toolCalling: false,

			vision: false,

			thinking: true,

			...limits,

			supportsReasoningEffort: ['low', 'medium', 'high', 'max'],

			reasoningEffortFormat: 'chat-completions',

		};

	}



	return {

		name: humanize(modelId),

		toolCalling: true,

		vision: isDeepSeekVisionCapableId(modelId),

		...limits,

	};

}



/**

 * DeepSeek BYOK provider.

 *

 * Uses the OpenAI-compatible Chat Completions endpoint exposed by DeepSeek at

 * `https://api.deepseek.com/v1`.

 *

 * Production models (see https://api-docs.deepseek.com/):

 * - `deepseek-v4-flash` / legacy `deepseek-chat` — fast chat, tools, vision (image_url)

 * - `deepseek-v4-pro` — frontier chat, tools, vision

 * - `deepseek-reasoner` — thinking mode; tools off (reasoning_content round-trip)

 */

export class DeepSeekBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {



	public static readonly providerName = 'DeepSeek';

	public static readonly providerId = this.providerName.toLowerCase();



	constructor(

		knownModels: BYOKKnownModels,

		byokStorageService: IBYOKStorageService,

		@IFetcherService fetcherService: IFetcherService,

		@ILogService logService: ILogService,

		@IInstantiationService instantiationService: IInstantiationService,

		@IConfigurationService configurationService: IConfigurationService,

		@IExperimentationService expService: IExperimentationService

	) {

		super(

			DeepSeekBYOKLMProvider.providerId,

			DeepSeekBYOKLMProvider.providerName,

			knownModels,

			byokStorageService,

			fetcherService,

			logService,

			instantiationService,

			configurationService,

			expService

		);

	}



	protected getModelsBaseUrl(): string {

		return 'https://api.deepseek.com/v1';

	}



	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {

		const data = modelData as DeepSeekModelData;

		if (!data?.id) {

			return undefined;

		}

		return resolveDeepSeekModelCapabilities(data.id, id => this.humanize(id));

	}



	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>): Promise<OpenAIEndpoint> {

		const modelInfo = this.getModelInfo(model.id, model.url);

		const url = `${model.url}/chat/completions`;

		return this._instantiationService.createInstance(DeepSeekEndpoint, modelInfo, model.configuration?.apiKey ?? '', url);

	}



	private humanize(modelId: string): string {

		return modelId

			.split('-')

			.filter(p => p.length > 0)

			.map(p => (/^\d+(\.\d+)?$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))

			.join(' ');

	}

}



/**

 * DeepSeek-specific endpoint that adapts the OpenAI-compatible request body

 * to DeepSeek's API conventions:

 *

 * 1. Explicit thinking toggle. DeepSeek defaults thinking to "enabled" for

 *    hybrid models, which causes the model to emit `reasoning_content`. The

 *    Copilot agent loop currently does not round-trip that field, which

 *    triggers the upstream 400:

 *       "The reasoning_content in the thinking mode must be passed back to the API."

 *    We set `thinking.type` explicitly per model so the contract is

 *    deterministic.

 *

 * 2. `max_tokens` shape. The base `OpenAIEndpoint.interceptBody` renames

 *    `max_tokens` to `max_completion_tokens` for any model whose capabilities

 *    advertise `thinking: true` (OpenAI o1/o3 convention). DeepSeek does NOT

 *    accept `max_completion_tokens` on `/v1/chat/completions` and treats the

 *    field as unknown. We restore the OpenAI Chat Completions shape so the

 *    output token cap is actually enforced by the server.

 */

export class DeepSeekEndpoint extends OpenAIEndpoint {

	constructor(

		modelMetadata: IChatModelInformation,

		apiKey: string,

		modelUrl: string,

		@IDomainService domainService: IDomainService,

		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,

		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,

		@IInstantiationService instantiationService: IInstantiationService,

		@IConfigurationService configurationService: IConfigurationService,

		@IExperimentationService expService: IExperimentationService,

		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,

		@ILogService logService: ILogService,

	) {

		super(modelMetadata, apiKey, modelUrl, domainService, chatMLFetcher, tokenizerProvider, instantiationService, configurationService, expService, chatWebSocketService, logService);

	}



	override interceptBody(body: IEndpointBody | undefined): void {

		super.interceptBody(body);

		if (!body) {

			return;

		}



		// 1. Restore OpenAI Chat-Completions `max_tokens` shape. The base class

		//    renames it to `max_completion_tokens` whenever the model declares

		//    thinking support; DeepSeek expects `max_tokens` on

		//    /v1/chat/completions regardless of thinking mode.

		if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {

			body.max_tokens = body.max_completion_tokens;

			delete body.max_completion_tokens;

		}



		// 2. Force-disable thinking on non-reasoner models so the server never

		//    returns `reasoning_content`. For the reasoner family we

		//    explicitly enable it; this also makes the toggle deterministic

		//    regardless of upstream server defaults.

		const modelId = this.modelMetadata.id;

		if (isDeepSeekReasonerId(modelId)) {

			body.thinking = { ...body.thinking, type: 'enabled' };

		} else {

			body.thinking = { type: 'disabled' };

		}



		// 3. Strip any stray `reasoning_content` field that an upstream caller

		//    might have appended to historical assistant messages. The OpenAI

		//    Chat-Completions JSON shape does not include this field; the

		//    DeepSeek API tolerates it on non-tool-call turns, but we keep the

		//    payload clean to avoid validation surprises if the upstream

		//    schema tightens.

		if (Array.isArray(body.messages)) {

			for (const msg of body.messages) {

				if (msg && typeof msg === 'object' && 'reasoning_content' in msg && !Array.isArray(msg.tool_calls)) {

					delete (msg as Record<string, unknown>).reasoning_content;

				}

			}

		}

	}

}


