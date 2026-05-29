# Model Management Notes

## Purpose

Keep TheCoder model settings aligned with the models that are actually available in the app.

## Current pattern

- Use a boolean setting for enabling/disabling a behavior.
- Use a dynamic enum for model selection so the Settings UI shows a real dropdown.
- Reuse the same model discovery source that powers the picker, so the settings list stays current.

## Relevant files

- `src/vs/workbench/contrib/chat/browser/utilityModelContribution.ts`
- `src/vs/workbench/contrib/chat/browser/defaultModelContribution.ts`
- `src/vs/workbench/contrib/chat/browser/thecoderVisionConfiguration.contribution.ts`

## Pricing (BYOK)

- List prices are **USD per 1M tokens** internally (`byokPricing.ts`, `sessionCostTracker.ts`).
- **OpenRouter** `/models` returns USD **per token** — converted × `1_000_000` in `openRouterProvider.ts`.
- On TheCoder launch, `BYOKContrib._refreshProviderPricingOnStartup` clears `clearResolvedModelPricing()`, refreshes FX, and calls `lm.selectChatModels({ vendor })` for each provider with a stored API key so rates are re-fetched.
- Model picker labels use **four decimal places** via `CurrencyService.formatPerMillion`.
- Provider-scoped cache keys (`provider/modelId`) prevent OpenRouter rates from overwriting direct DeepSeek builtin rates.

## Maintenance note

- If a new TheCoder model-backed setting is added, prefer the same pattern: a clear toggle plus a dynamic model enum.

## Troubleshooting: `Can not add index to parent of type array`

This happens when `settings.json` root is `[]` instead of `{}`. The settings writer cannot add keys like `chat.utilityModel` to an array.

- **Fix in code:** `src/vs/base/common/jsonEdit.ts` — `coerceSettingsObjectRoot()` resets an array root to `{}` before `setProperty`.
- **Manual fix:** open `%APPDATA%\.thecoder\User\settings.json` (or portable `data\user-data\User\settings.json`) and replace `[]` with `{}`, then set utility models again.
