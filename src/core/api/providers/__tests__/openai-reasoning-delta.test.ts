import "should"
import sinon from "sinon"
import { describe, it, afterEach } from "mocha"
import { OpenAiHandler } from "../openai"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

const collect = async (deltas: any[]) => {
	const handler = new OpenAiHandler({
		openAiApiKey: "ollama",
		openAiBaseUrl: "http://127.0.0.1:11434/v1",
		openAiModelId: "qwen3.8:27b-mlx-64k",
	} as any)
	const create = sinon.stub().resolves(createAsyncIterable(deltas.map((delta) => ({ choices: [{ delta }] }))))
	sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } } as any)

	const chunks: any[] = []
	for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "hi" }] as any)) {
		chunks.push(chunk)
	}
	return chunks
}

describe("openai-compatible reasoning deltas", () => {
	afterEach(() => sinon.restore())

	it("surfaces `delta.reasoning` as reasoning (Ollama's field name)", async () => {
		const chunks = await collect([{ reasoning: "weighing it up" }, { content: "Die Antwort lautet …" }])

		chunks.should.containEql({ type: "reasoning", reasoning: "weighing it up" })
		chunks.should.containEql({ type: "text", text: "Die Antwort lautet …" })
	})

	it("still surfaces `delta.reasoning_content` (DeepSeek-style field name)", async () => {
		const chunks = await collect([{ reasoning_content: "step one" }])

		chunks.should.containEql({ type: "reasoning", reasoning: "step one" })
	})

	it("does not emit reasoning for a plain content-only stream", async () => {
		const chunks = await collect([{ content: "plain answer" }])

		chunks.filter((c) => c.type === "reasoning").should.have.length(0)
	})

	it("stringifies a non-string reasoning payload rather than dropping it", async () => {
		const chunks = await collect([{ reasoning: { summary: "structured" } }])

		chunks.should.containEql({ type: "reasoning", reasoning: '{"summary":"structured"}' })
	})
})
