/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, type Memento } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { createServiceIdentifier } from '../../../util/common/services';

export const SUPPORTED_CURRENCIES = [
	'USD', 'EUR', 'PLN', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'MXN', 'KRW', 'SGD', 'SEK', 'NOK', 'CZK', 'DKK', 'HUF', 'TRY', 'ZAR', 'NZD', 'HKD', 'TWD',
] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

export const PRICING_CONFIG_NS = 'thecoder.pricing';
const CACHE_KEY = 'thecoder.pricing.fxCache.v1';
const DEFAULT_REFRESH_HOURS = 24;
/**
 * Free, no-key, CORS-friendly FX endpoint. Returns rates with USD as base.
 * Backup providers can be added by the user via `thecoder.pricing.fxProviderUrl`.
 */
const DEFAULT_FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';

const SYMBOLS: Record<string, string> = {
	USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', PLN: 'zł',
	CAD: 'C$', AUD: 'A$', CHF: 'CHF', INR: '₹', BRL: 'R$', MXN: 'MX$',
	KRW: '₩', SGD: 'S$', SEK: 'kr', NOK: 'kr', CZK: 'Kč', DKK: 'kr',
	HUF: 'Ft', TRY: '₺', ZAR: 'R', NZD: 'NZ$', HKD: 'HK$', TWD: 'NT$',
};

interface FxCachePayload {
	readonly base: 'USD';
	readonly rates: Readonly<Record<string, number>>;
	readonly fetchedAt: number;
}

interface ErApiResponse {
	result?: string;
	base_code?: string;
	rates?: Record<string, number>;
	time_last_update_unix?: number;
}

export const ICurrencyService = createServiceIdentifier<ICurrencyService>('ICurrencyService');

export interface ICurrencyService {
	readonly _serviceBrand: undefined;
	/** Return the user's preferred display currency code, e.g. `'PLN'`. Falls back to `'USD'`. */
	getCurrency(): SupportedCurrency;
	/** Whether pricing should be shown at all (driven by `thecoder.pricing.show`). */
	isEnabled(): boolean;
	/** Currency symbol (or ISO code if no symbol mapping is available). */
	getSymbol(currency?: string): string;
	/**
	 * Convert a USD amount to the user's selected currency using cached FX
	 * rates. If no rates are cached yet — e.g. first call before
	 * {@link refreshIfStale} resolves — returns the USD amount unchanged.
	 */
	convertFromUSD(amountUSD: number, currency?: string): number;
	/** Background refresh of FX rates if the cache is older than the configured TTL. */
	refreshIfStale(force?: boolean): Promise<void>;
	/**
	 * Pretty-print a USD amount in the user's currency with a `${symbol}{value}/1M`
	 * shape. Used both in model picker labels and tooltips.
	 */
	formatPerMillion(usdPerMillion: number, currency?: string): string;
	/**
	 * Pretty-print an arbitrary USD amount in the user's currency. Used for
	 * session cost displays where values can span six orders of magnitude
	 * (sub-cent to large totals) and need adaptive precision.
	 */
	formatAmount(amountUSD: number, currency?: string): string;
	/**
	 * Pretty-print an amount that is *already* expressed in the target
	 * currency (no FX conversion). Used for provider balances returned
	 * natively in USD/CNY or after {@link convertFromUSD}.
	 */
	formatNativeAmount(amount: number, currency?: string): string;
}

/**
 * BYOK-local FX service. Pulls rates from a free public endpoint
 * (open.er-api.com) and caches the result in the extension's global state
 * for 24h by default. The cache is keyed by the latest base-USD rates so all
 * supported display currencies are computed from a single fetch.
 */
export class CurrencyService implements ICurrencyService {
	declare readonly _serviceBrand: undefined;

	private _state: FxCachePayload | undefined;
	private _inflight: Promise<void> | undefined;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
	) {
		this._state = this._readCache(this._extensionContext.globalState);
		// Fire a refresh in the background so first-time users do not have to
		// wait for the network; results land before they hover a model in the
		// picker in the vast majority of cases.
		void this.refreshIfStale().catch(() => { /* logged inside */ });
	}

	getCurrency(): SupportedCurrency {
		const value = this._readConfig<string>('currency', 'USD').toUpperCase();
		return (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
			? value as SupportedCurrency
			: 'USD';
	}

	isEnabled(): boolean {
		return this._readConfig<boolean>('show', true);
	}

	getSymbol(currency?: string): string {
		const code = (currency ?? this.getCurrency()).toUpperCase();
		return SYMBOLS[code] ?? code;
	}

	convertFromUSD(amountUSD: number, currency?: string): number {
		const code = (currency ?? this.getCurrency()).toUpperCase();
		if (code === 'USD') {
			return amountUSD;
		}
		const rate = this._state?.rates?.[code];
		if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
			return amountUSD;
		}
		return amountUSD * rate;
	}

	formatPerMillion(usdPerMillion: number, currency?: string): string {
		const code = (currency ?? this.getCurrency()).toUpperCase();
		const converted = this.convertFromUSD(usdPerMillion, code);
		const symbol = this.getSymbol(code);
		// Model picker: fixed four decimal places (e.g. $0.1400 / $0.2800 per 1M).
		return this._withSymbol(code, symbol, converted.toFixed(4));
	}

	formatAmount(amountUSD: number, currency?: string): string {
		const code = (currency ?? this.getCurrency()).toUpperCase();
		const converted = this.convertFromUSD(amountUSD, code);
		const symbol = this.getSymbol(code);
		// Adaptive precision so a $0.0003 micro-session and a $42 long-running
		// session both look sensible without engineering notation.
		let formatted: string;
		const abs = Math.abs(converted);
		if (abs === 0) {
			formatted = '0.00';
		} else if (abs < 0.01) {
			// Pull at least two significant digits but cap at 6 decimal places.
			const exp = -Math.floor(Math.log10(abs));
			const digits = Math.min(6, Math.max(2, exp + 1));
			formatted = converted.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
		} else if (abs < 1) {
			formatted = converted.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
		} else if (abs < 100) {
			formatted = converted.toFixed(2);
		} else if (abs < 10_000) {
			formatted = converted.toFixed(1).replace(/\.0$/, '');
		} else {
			formatted = converted.toFixed(0);
		}
		return this._withSymbol(code, symbol, formatted);
	}

	formatNativeAmount(amount: number, currency?: string): string {
		const code = (currency ?? this.getCurrency()).toUpperCase();
		const symbol = this.getSymbol(code);
		let formatted: string;
		const abs = Math.abs(amount);
		if (abs === 0) {
			formatted = '0.00';
		} else if (abs < 0.01) {
			const exp = -Math.floor(Math.log10(abs));
			const digits = Math.min(6, Math.max(2, exp + 1));
			formatted = amount.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
		} else if (abs < 1) {
			formatted = amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
		} else if (abs < 100) {
			formatted = amount.toFixed(2);
		} else if (abs < 10_000) {
			formatted = amount.toFixed(1).replace(/\.0$/, '');
		} else {
			formatted = amount.toFixed(0);
		}
		return this._withSymbol(code, symbol, formatted);
	}

	private _withSymbol(code: string, symbol: string, formatted: string): string {
		const placePrefix = SYMBOLS[code] && code !== 'PLN' && code !== 'SEK' && code !== 'NOK' && code !== 'CZK' && code !== 'DKK' && code !== 'HUF';
		return placePrefix ? `${symbol}${formatted}` : `${formatted} ${symbol}`;
	}

	async refreshIfStale(force?: boolean): Promise<void> {
		if (this._inflight) {
			return this._inflight;
		}
		const ttlHours = this._readConfig<number>('fxRefreshHours', DEFAULT_REFRESH_HOURS);
		const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
		const ageMs = this._state ? Date.now() - this._state.fetchedAt : Infinity;
		if (!force && ageMs < ttlMs) {
			return;
		}
		this._inflight = this._doRefresh().finally(() => { this._inflight = undefined; });
		return this._inflight;
	}

	private async _doRefresh(): Promise<void> {
		const url = this._readConfig<string>('fxProviderUrl', DEFAULT_FX_ENDPOINT);
		try {
			const response = await this._fetcherService.fetch(url, {
				method: 'GET',
				headers: { 'Accept': 'application/json' },
				callSite: 'thecoder-pricing-fx',
			});
			if (!response.ok) {
				throw new Error(`FX endpoint returned ${response.status}`);
			}
			const data = await response.json() as ErApiResponse;
			if (data.result === 'error' || !data.rates) {
				throw new Error('FX endpoint returned no rates');
			}
			const base = (data.base_code ?? 'USD').toUpperCase();
			if (base !== 'USD') {
				// We currently only support USD-base feeds; renormalise here if/when
				// users plug in alternative endpoints that publish in EUR/GBP.
				const usdRate = data.rates['USD'];
				if (!usdRate) {
					throw new Error(`Unsupported FX base ${base}`);
				}
				const renormalised: Record<string, number> = {};
				for (const [code, rate] of Object.entries(data.rates)) {
					renormalised[code] = rate / usdRate;
				}
				this._state = { base: 'USD', rates: renormalised, fetchedAt: Date.now() };
			} else {
				this._state = { base: 'USD', rates: data.rates, fetchedAt: Date.now() };
			}
			await this._writeCache(this._extensionContext.globalState, this._state);
		} catch (err) {
			this._logService.warn(`[thecoder.pricing] FX refresh failed: ${(err as Error)?.message ?? err}`);
		}
	}

	private _readCache(memento: Memento): FxCachePayload | undefined {
		const raw = memento.get<FxCachePayload>(CACHE_KEY);
		if (!raw || typeof raw !== 'object' || !raw.rates || typeof raw.fetchedAt !== 'number') {
			return undefined;
		}
		return raw;
	}

	private async _writeCache(memento: Memento, payload: FxCachePayload): Promise<void> {
		try {
			await memento.update(CACHE_KEY, payload);
		} catch {
			// Persisting FX cache is best-effort: a failure just means the next
			// session will refetch, which is fine.
		}
	}

	private _readConfig<T>(key: string, defaultValue: T): T {
		// Read directly from the workbench configuration so we pick up live
		// edits without restart. The chat extension's typed configuration
		// wrapper does not expose `thecoder.pricing.*`, so we read via the
		// stock `workspace.getConfiguration` instead.
		const cfg = workspace.getConfiguration(PRICING_CONFIG_NS);
		const value = cfg.get<T>(key);
		if (value === undefined || value === null) {
			return defaultValue;
		}
		return value;
	}
}
