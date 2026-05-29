/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MemoryCategory } from './memoryTankStore';

export interface ConversationTurn {
	at: string;
	modelId: string;
	userText?: string;
	assistantText?: string;
}

export interface DigestedMemory {
	title: string;
	content: string;
	category: MemoryCategory;
	tags: string[];
}

const DECISION_PATTERNS = [
	/\b(decided|decyzja|ustaliliśmy|going with|will use|wybieramy|używamy|instead of|rather than|final approach)\b/i,
	/\b(architecture|architektura|design pattern|convention|standard)\b/i,
];
const MILESTONE_PATTERNS = [
	/\b(milestone|kamień milowy|release|shipped|deployed|v\d+\.\d+|faza|phase \d|sprint)\b/i,
	/\b(done|completed|finished|zrobione|ukończone|gotowe)\b.*\b(feature|task|fix|implement)/i,
];
const TODO_PATTERNS = [
	/\b(TODO|FIXME|next step|następny krok|pending|remaining|do zrobienia|jeszcze trzeba)\b/i,
];
const REMEMBER_PATTERNS = [
	/\b(remember|zapamiętaj|note that|ważne:|important:)\b/i,
];

/** Turn raw chat into structured memory entries (decisions, milestones, todos). */
export function digestConversation(turns: ConversationTurn[]): DigestedMemory[] {
	const entries: DigestedMemory[] = [];
	const seen = new Set<string>();

	for (const turn of turns) {
		const blob = [turn.userText, turn.assistantText].filter(Boolean).join('\n');
		if (!blob.trim()) { continue; }

		for (const line of blob.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length < 12 || trimmed.length > 500) { continue; }

			const key = trimmed.slice(0, 120).toLowerCase();
			if (seen.has(key)) { continue; }

			let category: MemoryCategory | undefined;
			let tags: string[] = ['conversation', 'auto', 'extracted'];

			if (MILESTONE_PATTERNS.some(p => p.test(trimmed))) {
				category = 'milestone';
				tags.push('milestone');
			} else if (DECISION_PATTERNS.some(p => p.test(trimmed))) {
				category = 'decision';
				tags.push('decision');
			} else if (TODO_PATTERNS.some(p => p.test(trimmed))) {
				category = 'todo';
				tags.push('todo');
			} else if (REMEMBER_PATTERNS.some(p => p.test(trimmed))) {
				category = 'fact';
				tags.push('remember');
			}

			if (!category) { continue; }
			seen.add(key);

			entries.push({
				title: makeTitle(trimmed, category),
				content: [
					`Extracted from chat (${turn.at}, ${turn.modelId}):`,
					'',
					trimmed,
				].join('\n'),
				category,
				tags,
			});
		}
	}

	// Session summary (short — not a full transcript)
	if (turns.length > 0) {
		const topics = turns
			.map(t => t.userText?.split('\n')[0]?.trim())
			.filter((l): l is string => !!l && l.length > 8 && l.length < 200)
			.slice(0, 5);
		if (topics.length) {
			entries.push({
				title: `Session topics (${turns.length} turns)`,
				content: [
					'# Chat session digest',
					'',
					'User topics covered in this session:',
					...topics.map((t, i) => `${i + 1}. ${t}`),
					'',
					`_Digested at ${new Date().toISOString()}_`,
				].join('\n'),
				category: 'progress',
				tags: ['conversation', 'auto', 'session-summary'],
			});
		}
	}

	return entries.slice(0, 12);
}

function makeTitle(line: string, category: MemoryCategory): string {
	const prefix = category === 'milestone' ? 'Milestone'
		: category === 'decision' ? 'Decision'
			: category === 'todo' ? 'TODO'
				: 'Note';
	const body = line.replace(/^[-*#>\s]+/, '').slice(0, 80);
	return `${prefix}: ${body}${line.length > 80 ? '…' : ''}`;
}
