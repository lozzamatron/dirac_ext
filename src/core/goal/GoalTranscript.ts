import type { DiracStorageMessage, TranscriptPage } from "@shared/messages/content"

export const MAX_TRANSCRIPT_PAGE_BYTES = 32 * 1024

/** The cursor is messageIndex[:JSON character offset]; old message-only cursors remain valid. */
export function goalTranscriptPage(history: DiracStorageMessage[], cursor: string | undefined, limit: number): TranscriptPage {
	if (cursor !== undefined && !/^\d+(?::\d+)?$/.test(cursor)) throw new Error("Invalid transcript cursor")
	const [index, offset = 0] = (cursor ?? "0").split(":").map(Number)
	if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index > history.length) {
		throw new Error("Invalid transcript cursor")
	}
	const entries: DiracStorageMessage[] = []
	for (let next = index; next < history.length && entries.length < limit; next++) {
		const entry = history[next]
		const candidate: TranscriptPage = { entries: [...entries, entry], nextCursor: String(next + 1) }
		if (offset === 0 && Buffer.byteLength(JSON.stringify(candidate)) <= MAX_TRANSCRIPT_PAGE_BYTES) {
			entries.push(entry)
			continue
		}
		if (entries.length) return { entries, nextCursor: String(next) }
		return transcriptFragment(entry, next, offset, history.length)
	}
	if (offset !== 0) throw new Error("Transcript fragment cursor is past the end of the history")
	const next = index + entries.length
	return { entries, ...(next < history.length ? { nextCursor: String(next) } : {}) }
}

function transcriptFragment(entry: DiracStorageMessage, index: number, offset: number, historyLength: number): TranscriptPage {
	const json = JSON.stringify(entry)
	if (offset >= json.length) throw new Error("Transcript fragment cursor is past the end of the message")
	const pageAt = (end: number): TranscriptPage => ({
		entries: [],
		fragment: { messageIndex: index, offset, totalCharacters: json.length, json: json.slice(offset, end) },
		...(end < json.length
			? { nextCursor: `${index}:${end}` }
			: index + 1 < historyLength
				? { nextCursor: String(index + 1) }
				: {}),
	})
	let low = offset
	let high = Math.min(json.length, offset + MAX_TRANSCRIPT_PAGE_BYTES)
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(JSON.stringify(pageAt(middle))) <= MAX_TRANSCRIPT_PAGE_BYTES) low = middle
		else high = middle - 1
	}
	// Do not split a UTF-16 surrogate pair across JSON fragments.
	if (low < json.length && /[\uD800-\uDBFF]/.test(json[low - 1])) low--
	return pageAt(low)
}
