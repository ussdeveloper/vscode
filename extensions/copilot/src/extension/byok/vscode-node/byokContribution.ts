/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, LanguageModelChatInformation, LanguageModelChatProvider, lm, window, workspace } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, isClientBYOKAllowed } from '../../byok/common/byokProvider';
import { clearResolvedModelPricing, ModelPricingUSD, setPricingDecoratorContext } from '../../byok/common/byokPricing';
import { IExtensionContribution } from '../../common/contributions';
import { AbstractLanguageModelChatProvider } from './abstractLanguageModelChatProvider';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CurrencyService, PRICING_CONFIG_NS } from './currencyService';
import { CustomEndpointBYOKModelProvider } from './customEndpointProvider';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { DEEPSEEK_KNOWN_MODELS, DeepSeekBYOKLMProvider } from './deepseekProvider';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { SessionCostTracker, setSessionCostTracker } from './sessionCostTracker';
import { ImageDescriptionService, setImageDescriptionService } from './imageDescriptionService';
import { configureProviderApiKey } from './configureProviderApiKey';
import { XAIBYOKLMProvider } from './xAIProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, LanguageModelChatProvider<LanguageModelChatInformation>> = new Map();
	private readonly _providerRegistrations = this._register(new DisposableStore());
	private _providersRegistered = false;
	private _knownModelsRefreshed = false;
	private _knownModelsRefreshTargets: ReadonlyArray<readonly [string, AbstractLanguageModelChatProvider]> = [];
	private _providerPricingRefreshedOnStartup = false;
	private readonly _currencyService: CurrencyService;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IVSCodeExtensionContext private readonly _vsCodeExtensionContext: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._byokStorageService = new BYOKStorageService(this._vsCodeExtensionContext);

		// TheCoder pricing: wire a currency service into the pricing decorator
		// before the provider list is built so the very first model snapshot
		// already carries pricing fields. The FX cache is read synchronously
		// from globalState; a network refresh is fired in the background.
		const currencyService = this._instantiationService.createInstance(CurrencyService);
		this._currencyService = currencyService;
		setPricingDecoratorContext({
			isEnabled: () => currencyService.isEnabled(),
			getCurrency: () => currencyService.getCurrency(),
			getSymbol: (currency?: string) => currencyService.getSymbol(currency),
			convertFromUSD: (amount: number, currency?: string) => currencyService.convertFromUSD(amount, currency),
			formatPerMillion: (usdPerMillion: number, currency?: string) => currencyService.formatPerMillion(usdPerMillion, currency),
			getCustomRates: () => {
				const cfg = workspace.getConfiguration(PRICING_CONFIG_NS);
				const raw = cfg.get<Record<string, ModelPricingUSD>>('customRates');
				return raw && typeof raw === 'object' ? raw : undefined;
			},
		});
		this._register({
			dispose: () => setPricingDecoratorContext(undefined),
		});

		// TheCoder session cost: instantiate the tracker, publish it through
		// the module-level accessor so `CopilotLanguageModelWrapper` can find
		// it without an explicit IoC dependency, and register the reset
		// command + a configuration-aware refresh.
		const sessionCostTracker = new SessionCostTracker(currencyService);
		this._register(sessionCostTracker);
		setSessionCostTracker(sessionCostTracker);
		this._register({ dispose: () => setSessionCostTracker(undefined) });
		this._register(commands.registerCommand('thecoder.resetSessionCost', () => {
			sessionCostTracker.reset();
			void window.showInformationMessage('TheCoder: session cost reset.');
		}));

		const imageDescriptionService = new ImageDescriptionService(this._logService);
		setImageDescriptionService(imageDescriptionService);
		this._register({ dispose: () => setImageDescriptionService(undefined) });

		this._register(commands.registerCommand('thecoder.openSettings', () => {
			return commands.executeCommand('workbench.action.openSettings', 'thecoder');
		}));

		// TheCoder: F1-discoverable alias to the built-in
		// `workbench.action.chat.manage` command. Upstream guards the built-in
		// version behind `LANGUAGE_MODELS_ENTITLEMENT_PRECONDITION`, which
		// in turn requires either a Copilot plan or our newly forced
		// `clientByokEnabled` context key. Exposing a parallel command keeps
		// the management view reachable even if the precondition ever races
		// or regresses, and it gives users a memorable name to search for.
		this._register(commands.registerCommand('thecoder.openModelManagement', () => {
			return commands.executeCommand('workbench.action.chat.manage');
		}));

		// TheCoder: direct API-key prompt (used by balance badge, first-run,
		// portable migration). Never opens the Manage Models editor.
		this._register(commands.registerCommand('thecoder.configureDeepSeekApiKey', () => {
			return configureProviderApiKey(this._byokStorageService, 'deepseek');
		}));

		// TheCoder: first-run nudge to the management view. If the user has
		// not yet configured any BYOK provider, opening the model manager on
		// first launch removes the chicken-and-egg of "there's no model so
		// there's no picker to find the gear in". We schedule this with a
		// short delay so workbench layout + commands are ready, and we mark
		// it as shown in globalState so it never auto-pops twice.
		void this._maybeOfferFirstRunModelManager();

		// TheCoder: detect "portable build moved to another machine". The
		// `state.vscdb` travels with the portable folder but the SAFEStorage
		// (DPAPI on Windows / Keychain on macOS) key is per-host, so the
		// previously-stored API key ciphertext can no longer be decrypted.
		// We persist a small *plaintext* fingerprint in globalState (which
		// migrates fine) so we can spot the mismatch and pop the model
		// manager with an explanatory toast instead of failing silently.
		void this._detectPortableMigration();

		this._applyPolicy();
		this._register(this._authService.onDidAuthenticationChange(() => this._applyPolicy()));
	}

	private async _maybeOfferFirstRunModelManager(): Promise<void> {
		const FIRST_RUN_SHOWN_KEY = 'thecoder.modelManagerFirstRunShown';
		try {
			if (!workspace.getConfiguration('thecoder').get<boolean>('firstRunOpenModelManager', true)) {
				return;
			}
			const ctx = this._vsCodeExtensionContext.globalState;
			if (ctx.get<boolean>(FIRST_RUN_SHOWN_KEY) === true) {
				return;
			}
			// "No BYOK configured yet" heuristic: walk every known provider
			// name and see if `byokStorageService` has at least one config
			// blob. We check by listing groups -- empty list across all
			// providers means a clean profile.
			const hasAnyKey = await this._anyByokKeyStored();
			if (hasAnyKey) {
				// User already has at least one key configured -- they know
				// the flow; mark first-run as done and stay silent.
				await ctx.update(FIRST_RUN_SHOWN_KEY, true);
				return;
			}
			// Defer slightly: the chat panel + commands are registered very
			// late in activation, and firing the command before
			// `workbench.action.chat.manage` is contributed throws.
			setTimeout(() => {
				void configureProviderApiKey(this._byokStorageService, 'deepseek');
			}, 1500);
			await ctx.update(FIRST_RUN_SHOWN_KEY, true);
		} catch (err) {
			this._logService.warn(`TheCoder: first-run model manager nudge failed: ${err}`);
		}
	}

	private async _detectPortableMigration(): Promise<void> {
		const FINGERPRINT_KEY = 'thecoder.byokKeyFingerprint';
		const ctx = this._vsCodeExtensionContext.globalState;
		try {
			const known = this._knownProviderNames();
			const readable: string[] = [];
			for (const name of known) {
				try {
					const k = await this._byokStorageService.getAPIKey(name);
					if (k) { readable.push(name); }
				} catch { /* unreadable -- treat as missing */ }
			}
			const previous = ctx.get<string[]>(FINGERPRINT_KEY, []);
			const lostProviders = previous.filter(p => !readable.includes(p));

			if (lostProviders.length > 0) {
				this._logService.warn(`TheCoder: portable migration detected -- keys unreadable for: ${lostProviders.join(', ')}`);
				// Defer until commands are wired up. Show a notification
				// with a single, opinionated CTA: re-enter keys.
				setTimeout(async () => {
					const choice = await window.showWarningMessage(
						`TheCoder: API keys for ${lostProviders.join(', ')} can't be decrypted on this machine ` +
						`(keys are protected by the OS keystore, which is per-host). Re-enter them now?`,
						{ modal: false },
						'Enter API Key',
						'Later',
					);
					if (choice === 'Enter API Key') {
						void configureProviderApiKey(this._byokStorageService, 'deepseek');
					}
				}, 2000);
			}

			// Update fingerprint to reflect the current readable set; the
			// migration banner is one-shot per move.
			if (JSON.stringify(previous) !== JSON.stringify(readable)) {
				await ctx.update(FINGERPRINT_KEY, readable);
			}
		} catch (err) {
			this._logService.warn(`TheCoder: portable-migration detect failed: ${err}`);
		}
	}

	private _knownProviderNames(): string[] {
		return [
			AnthropicLMProvider.providerName,
			GeminiNativeBYOKLMProvider.providerName,
			XAIBYOKLMProvider.providerName,
			OAIBYOKLMProvider.providerName,
			DeepSeekBYOKLMProvider.providerName,
			OpenRouterLMProvider.providerName,
			AzureBYOKModelProvider.providerName,
			CustomOAIBYOKModelProvider.providerName,
			CustomEndpointBYOKModelProvider.providerName,
		];
	}

	private async _anyByokKeyStored(): Promise<boolean> {
		// `byokStorageService` doesn't expose a "list everything" API; the
		// API surface is per-provider (`getAPIKey(providerName)`). Check the
		// canonical providers we register; if none of them has a key, treat
		// the profile as fresh.
		const providerNames = [
			AnthropicLMProvider.providerName,
			GeminiNativeBYOKLMProvider.providerName,
			XAIBYOKLMProvider.providerName,
			OAIBYOKLMProvider.providerName,
			DeepSeekBYOKLMProvider.providerName,
			OpenRouterLMProvider.providerName,
			AzureBYOKModelProvider.providerName,
			CustomOAIBYOKModelProvider.providerName,
			CustomEndpointBYOKModelProvider.providerName,
		];
		for (const name of providerNames) {
			try {
				const key = await this._byokStorageService.getAPIKey(name);
				if (key) { return true; }
			} catch {
				// ignore; missing key === false
			}
		}
		return false;
	}

	private _buildProviders(): void {
		const instantiationService = this._instantiationService;

		const anthropic = instantiationService.createInstance(AnthropicLMProvider, undefined, this._byokStorageService);
		const gemini = instantiationService.createInstance(GeminiNativeBYOKLMProvider, undefined, this._byokStorageService);
		const xai = instantiationService.createInstance(XAIBYOKLMProvider, {}, this._byokStorageService);
		const openai = instantiationService.createInstance(OAIBYOKLMProvider, {}, this._byokStorageService);
		const deepseek = instantiationService.createInstance(DeepSeekBYOKLMProvider, DEEPSEEK_KNOWN_MODELS, this._byokStorageService);

		this._providers.set(OllamaLMProvider.providerId, instantiationService.createInstance(OllamaLMProvider, this._byokStorageService));
		this._providers.set(AnthropicLMProvider.providerId, anthropic);
		this._providers.set(GeminiNativeBYOKLMProvider.providerId, gemini);
		this._providers.set(XAIBYOKLMProvider.providerId, xai);
		this._providers.set(OAIBYOKLMProvider.providerId, openai);
		this._providers.set(DeepSeekBYOKLMProvider.providerId, deepseek);
		this._providers.set(OpenRouterLMProvider.providerId, instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
		this._providers.set(AzureBYOKModelProvider.providerId, instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
		this._providers.set(CustomOAIBYOKModelProvider.providerId, instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));
		this._providers.set(CustomEndpointBYOKModelProvider.providerId, instantiationService.createInstance(CustomEndpointBYOKModelProvider, this._byokStorageService));

		this._knownModelsRefreshTargets = [
			[AnthropicLMProvider.providerName, anthropic],
			[GeminiNativeBYOKLMProvider.providerName, gemini],
			[XAIBYOKLMProvider.providerName, xai],
			[OAIBYOKLMProvider.providerName, openai],
			[DeepSeekBYOKLMProvider.providerName, deepseek],
		];
	}

	private _applyPolicy(): void {
		const allowed = isClientBYOKAllowed(!!this._authService.anyGitHubSession, this._authService.copilotToken);
		if (allowed && !this._providersRegistered) {
			if (this._providers.size === 0) {
				this._buildProviders();
			}
			for (const [providerId, provider] of this._providers) {
				this._providerRegistrations.add(lm.registerLanguageModelChatProvider(providerId, provider));
			}
			this._providersRegistered = true;
			this._logService.info(`BYOK: registered ${this._providers.size} provider(s): ${Array.from(this._providers.keys()).join(', ')}`);
			if (!this._providerPricingRefreshedOnStartup) {
				this._providerPricingRefreshedOnStartup = true;
				void this._refreshProviderPricingOnStartup().catch(err => {
					this._providerPricingRefreshedOnStartup = false;
					this._logService.warn(`BYOK: startup provider pricing refresh failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			if (!this._knownModelsRefreshed) {
				this._knownModelsRefreshed = true;
				void this._refreshKnownModels().catch(err => {
					this._knownModelsRefreshed = false;
					this._logService.warn(`BYOK: failed to refresh known models, will retry on next allowed transition: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
		} else if (!allowed && this._providersRegistered) {
			this._providerRegistrations.clear();
			this._providersRegistered = false;
			this._logService.info('BYOK: unregistered providers due to enterprise policy.');
		}
	}

	/**
	 * On each TheCoder launch: clear cached rates, refresh FX, and re-resolve
	 * models from provider APIs for every vendor that already has an API key.
	 */
	private async _refreshProviderPricingOnStartup(): Promise<void> {
		clearResolvedModelPricing();
		await this._currencyService.refreshIfStale(true);

		const vendors: ReadonlyArray<readonly [providerName: string, vendorId: string]> = [
			[DeepSeekBYOKLMProvider.providerName, DeepSeekBYOKLMProvider.providerId],
			[OpenRouterLMProvider.providerName, OpenRouterLMProvider.providerId],
			[AnthropicLMProvider.providerName, AnthropicLMProvider.providerId],
			[OAIBYOKLMProvider.providerName, OAIBYOKLMProvider.providerId],
			[XAIBYOKLMProvider.providerName, XAIBYOKLMProvider.providerId],
			[GeminiNativeBYOKLMProvider.providerName, GeminiNativeBYOKLMProvider.providerId],
		];

		for (const [providerName, vendorId] of vendors) {
			try {
				const apiKey = await this._byokStorageService.getAPIKey(providerName);
				if (!apiKey) {
					continue;
				}
				await lm.selectChatModels({ vendor: vendorId });
			} catch (err) {
				this._logService.trace(`BYOK: pricing refresh skipped for ${vendorId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private async _refreshKnownModels(): Promise<void> {
		const knownModels = await this._fetchKnownModelList(this._fetcherService);
		if (this._store.isDisposed) {
			return;
		}
		for (const [providerName, provider] of this._knownModelsRefreshTargets) {
			provider.updateKnownModels(knownModels[providerName]);
		}
	}

	private async _fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		this._logService.info('BYOK: fetching known models list');
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: 'GET', callSite: 'byok-known-models' })).json();
		// Use this for testing with changes from a local file. Don't check in
		// const data = JSON.parse((await this._fileSystemService.readFile(URI.file('/Users/roblou/code/vscode-engineering/chat/copilotChat.json'))).toString());
		if (data.version !== 1) {
			this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			return {};
		}
		this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
		return data.modelInfo;
	}
}
