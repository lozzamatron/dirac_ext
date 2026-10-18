import "should"
import { expect } from "chai"
import sinon from "sinon"
import * as net from "@/shared/net"
import { OpenAiResponsesCompatibleHandler } from "../openai-responses-compatible"

const tools = [
	{
		type: "function",
		function: { name: "read_file", description: "", parameters: { type: "object" } },
	},
] as any

const createAsyncIterable = (events: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* events
	},
})

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const chunks: unknown[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

describe("OpenAiResponsesCompatibleHandler", () => {
	afterEach(() => {
		sinon.restore()
	})

	it("does not send persisted-reasoning fields to Responses-compatible providers", async () => {
		const createStub = sinon.stub().resolves(createAsyncIterable())
		const handler = new OpenAiResponsesCompatibleHandler({
			openAiApiKey: "test-api-key",
			openAiModelId: "third-party-responses-model",
			openAiModelInfo: { supportsPersistedReasoning: true } as any,
		})
		sinon.stub(handler as any, "ensureClient").returns({ responses: { create: createStub } })

		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "old question" },
					{
						role: "assistant",
						id: "resp_123",
						modelInfo: { providerId: "openai-native", modelId: "gpt-5.6-terra", mode: "act" },
						content: "previous answer",
					},
					{ role: "user", content: "new question" },
				] as any,
				tools,
			),
		)

		const params = createStub.firstCall.args[0]
		expect(params.previous_response_id).to.equal(undefined)
		expect(params.reasoning?.context).to.equal(undefined)
		params.input.should.have.length(3)
	})

	it("passes custom headers to the OpenAI client", () => {
		const createClient = sinon.stub(net, "createOpenAIClient").returns({} as any)
		const handler = new OpenAiResponsesCompatibleHandler({
			openAiApiKey: "test-api-key",
			openAiHeaders: { "x-opencode-session": "dirac-001" },
		})

		const client = (handler as any).ensureClient()

		expect(client).to.deep.equal({})
		expect(createClient.firstCall.args[0].defaultHeaders).to.deep.equal({
			"x-opencode-session": "dirac-001",
		})
	})

})
