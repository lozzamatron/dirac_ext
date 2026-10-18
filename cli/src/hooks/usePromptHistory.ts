import { useCallback, useEffect, useRef } from "react"
import { getRecentUniquePrompts, type UserPrompt } from "@shared/messages/prompt-history"

interface Draft {
	text: string
	cursorPos: number
}

interface UsePromptHistoryProps<T extends Draft> {
	scopeKey: string
	loadHistory: () => Promise<UserPrompt[]>
	currentPrompts: UserPrompt[]
	captureDraft: () => T
	restoreDraft: (draft: T) => void
	recallText: (text: string) => void
	onError: (error: unknown) => void
}

/** Browsing keeps a stable history snapshot and restores the complete original composer draft. */
export function usePromptHistory<T extends Draft>(props: UsePromptHistoryProps<T>) {
	const propsRef = useRef(props)
	propsRef.current = props
	const generationRef = useRef(0)
	const historyRef = useRef<Promise<UserPrompt[]>>(Promise.resolve([]))
	const browsingRef = useRef<{ items: string[]; index: number; draft: T } | undefined>(undefined)
	const queueRef = useRef(Promise.resolve())

	const resetHistory = useCallback(() => {
		generationRef.current++
		browsingRef.current = undefined
		queueRef.current = Promise.resolve()
	}, [])

	useEffect(() => {
		resetHistory()
		const generation = generationRef.current
		const history = propsRef.current.loadHistory()
		historyRef.current = history
		// Surface storage failures even when the user hasn't started browsing.
		void history.catch((error) => {
			if (generationRef.current === generation) propsRef.current.onError(error)
		})
		return resetHistory
	}, [props.scopeKey, props.loadHistory, resetHistory])

	const navigateHistory = useCallback((direction: "older" | "newer") => {
		const generation = generationRef.current
		const navigate = async () => {
			if (generation !== generationRef.current) return
			let browsing = browsingRef.current
			if (!browsing) {
				if (direction === "newer") return
				const draft = propsRef.current.captureDraft()
				const stored = await historyRef.current
				if (generation !== generationRef.current) return
				const current = propsRef.current.captureDraft()
				// Never overwrite input edited while the initial disk read was in flight.
				if (current.text !== draft.text || current.cursorPos !== draft.cursorPos) {
					resetHistory()
					return
				}
				const items = getRecentUniquePrompts([...stored, ...propsRef.current.currentPrompts])
				if (items.length === 0) return
				browsing = { items, index: -1, draft }
				browsingRef.current = browsing
			}
			const index = direction === "older" ? Math.min(browsing.index + 1, browsing.items.length - 1) : browsing.index - 1
			if (index === browsing.index) return
			if (index < 0) {
				propsRef.current.restoreDraft(browsing.draft)
				browsingRef.current = undefined
				return
			}
			browsing.index = index
			propsRef.current.recallText(browsing.items[index])
		}
		queueRef.current = queueRef.current.then(navigate).catch((error) => {
			if (generation === generationRef.current) propsRef.current.onError(error)
		})
	}, [resetHistory])

	return { navigateHistory, resetHistory }
}
