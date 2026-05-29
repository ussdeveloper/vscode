/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-memory cache of BYOK provider API keys as last seen by
 * {@link AbstractLanguageModelChatProvider.provideLanguageModelChatInformation}.
 *
 * Why this exists: when a user configures DeepSeek via Manage Models, VS Code
 * stores the key in workbench secret storage (`chat.lm.secret.*`) and passes
 * the resolved `configuration.apiKey` into the provider on every model refresh.
 * The legacy `copilot-byok-<Provider>-api-key` extension secret is deleted
 * during migration, so other BYOK readers that
 * only read extension secrets see an empty key even though chat works fine.
 *
 * Caching the resolved key here lets balance / cost / diagnostics reuse the
 * exact same credential the model endpoint uses, without duplicating secret
 * plumbing or reading workbench-only storage from the extension host.
 */
const _cache = new Map<string, string>();

export function setCachedByokApiKey(providerId: string, apiKey: string | undefined): void {
	const id = providerId.toLowerCase();
	if (apiKey?.trim()) {
		_cache.set(id, apiKey.trim());
	} else {
		_cache.delete(id);
	}
}

export function getCachedByokApiKey(providerId: string): string | undefined {
	return _cache.get(providerId.toLowerCase());
}

export function clearCachedByokApiKey(providerId: string): void {
	_cache.delete(providerId.toLowerCase());
}
