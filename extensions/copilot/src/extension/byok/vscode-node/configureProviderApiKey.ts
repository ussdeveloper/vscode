/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, lm, window } from 'vscode';
import { BYOKAuthType } from '../../byok/common/byokProvider';
import { setCachedByokApiKey } from './byokApiKeyCache';
import { IBYOKStorageService } from './byokStorageService';
import { DeepSeekBYOKLMProvider } from './deepseekProvider';

const VENDOR_TO_PROVIDER: Record<string, string> = {
	deepseek: DeepSeekBYOKLMProvider.providerName,
};

/**
 * Prompt for a BYOK API key and persist it for chat.
 * Always uses a password input box — never opens Manage Models.
 */
export async function configureProviderApiKey(
	storage: IBYOKStorageService,
	vendorId = 'deepseek',
): Promise<boolean> {
	const providerName = VENDOR_TO_PROVIDER[vendorId];
	if (!providerName) {
		void window.showErrorMessage(`TheCoder: unknown provider \`${vendorId}\`.`);
		return false;
	}

	const apiKey = await window.showInputBox({
		title: `${providerName} API Key`,
		prompt: vendorId === 'deepseek'
			? 'Paste your key from https://platform.deepseek.com/api_keys'
			: `Enter your ${providerName} API key`,
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.trim() ? undefined : 'API key is required',
	});
	if (!apiKey?.trim()) {
		return false;
	}

	const trimmed = apiKey.trim();

	await storage.storeAPIKey(providerName, trimmed, BYOKAuthType.GlobalApiKey);
	setCachedByokApiKey(vendorId, trimmed);

	try {
		await commands.executeCommand('lm.migrateLanguageModelsProviderGroup', {
			vendor: vendorId,
			name: providerName,
			apiKey: trimmed,
		});
	} catch {
		// Group may already exist — storage is enough for chat.
	}

	try {
		await lm.selectChatModels({ vendor: vendorId });
	} catch { /* ignore */ }

	void window.showInformationMessage(`TheCoder: ${providerName} API key saved.`);
	return true;
}
