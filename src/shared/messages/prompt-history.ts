import { DiracMessageType, type DiracMessage } from "../ExtensionMessage"

export interface UserPrompt {
	text: string
	ts: number
}

/** Only human-authored transcript text, never API/tool payloads or attachments. */
export function getUserPrompts(messages: DiracMessage[]): UserPrompt[] {
	return messages.flatMap(({ content, ts }) =>
		content.type === DiracMessageType.MARKDOWN && content.role === "user" && content.content.trim()
			? [{ text: content.content, ts }]
			: [],
	)
}

export function getRecentUniquePrompts(prompts: UserPrompt[], limit = 100): string[] {
	const newestFirst = [...prompts].sort((left, right) => right.ts - left.ts).map(({ text }) => text)
	return [...new Set(newestFirst)].slice(0, limit)
}
