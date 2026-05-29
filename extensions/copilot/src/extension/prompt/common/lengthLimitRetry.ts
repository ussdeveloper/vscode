/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { MarkdownString } from '../../../vscodeTypes';

/** Safety margin applied to the endpoint output token ceiling for length-limit retries. */
export const LENGTH_RETRY_BUDGET_FACTOR = 0.9;

/** Orange tone for brief in-chat length-limit notices (TheCoder). */
const LENGTH_LIMIT_NOTICE_COLOR = '#e67e22';

/** Conservative chars-per-token estimate for human-readable budgets in retry prompts. */
const CHARS_PER_TOKEN_ESTIMATE = 3.5;

export interface ILengthLimitRetryBudget {
	readonly maxOutputTokens: number;
	readonly safeOutputTokens: number;
	readonly approximateMaxChars: number;
}

export function computeLengthLimitRetryBudget(maxOutputTokens: number): ILengthLimitRetryBudget {
	const safeOutputTokens = Math.max(256, Math.floor(maxOutputTokens * LENGTH_RETRY_BUDGET_FACTOR));
	const approximateMaxChars = Math.floor(safeOutputTokens * CHARS_PER_TOKEN_ESTIMATE);
	return { maxOutputTokens, safeOutputTokens, approximateMaxChars };
}

export function buildLengthLimitRetryUserMessage(budget: ILengthLimitRetryBudget, truncatedValue?: string): string {
	const truncatedSnippet = truncatedValue?.trim()
		? `\n\nYour truncated reply started with:\n---\n${truncateForRetryPrompt(truncatedValue, 1200)}\n---\n`
		: '';

	return `[TheCoder] Your previous response hit the output length limit (finish_reason=length). Continue the same task with a **shorter** reply.

**Hard limits for this retry** (${Math.round(LENGTH_RETRY_BUDGET_FACTOR * 100)}% of model max for safety):
- **Maximum output tokens: ${budget.safeOutputTokens}** (model ceiling: ${budget.maxOutputTokens} tokens)
- **Approximate character budget: ~${budget.approximateMaxChars} characters** (~${CHARS_PER_TOKEN_ESTIMATE} chars/token)

**Required workflow:**
1. Do **not** paste full files or large code blocks in assistant text.
2. Apply changes with tools (\`apply_patch\`, \`replace_in_file\`, \`insert_edit\`, \`create_file\`) — prefer **one small edit per tool call**.
3. Keep explanations brief (≤8 bullets); implement via tools, not long prose.
4. If many files need changes, do **at most 1–2 files** in this turn, then continue in the next message.
5. Stay **under** the token/character budgets above — shorter is better than hitting the limit again.${truncatedSnippet}

Acknowledge the limit briefly, then continue the task within budget.`;
}

function truncateForRetryPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return text.slice(0, maxChars) + '\n… [truncated for retry context]';
}

function buildOrangeLengthLimitNotice(text: string): MarkdownString {
	const md = new MarkdownString(
		`<span style="color:${LENGTH_LIMIT_NOTICE_COLOR}">$(warning) ${text}</span>`,
		{ supportThemeIcons: true },
	);
	md.supportHtml = true;
	return md;
}

/** Brief orange notice while a length-limit retry runs in the background. */
export function buildLengthLimitRetryingNotice(): MarkdownString {
	return buildOrangeLengthLimitNotice(
		l10n.t('Response too long — retrying automatically with a smaller output budget…'),
	);
}

/** Brief orange notice when length-limit retry did not succeed. */
export function buildLengthLimitFailedNotice(): MarkdownString {
	return buildOrangeLengthLimitNotice(
		l10n.t('Response still too long — use edit tools for changes instead of large code pastes.'),
	);
}

export function isResponseTooLongErrorMessage(message: string): boolean {
	return message === 'Response too long.' || message.startsWith('Response too long');
}
