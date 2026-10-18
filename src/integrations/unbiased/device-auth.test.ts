import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { pollUnbiasedDeviceAuth, UnbiasedAuthError, type UnbiasedDeviceGrant } from "./device-auth"

const grant: UnbiasedDeviceGrant = {
	deviceCode: "private-device-code",
	userCode: "BCDF-GHJK",
	verificationUri: "https://platform.unbiased.ai/activate",
	verificationUriComplete: "https://platform.unbiased.ai/activate?user_code=BCDF-GHJK",
	expiresIn: 900,
	interval: 1,
}

const issuedToken = {
	access_token: "sk_pareto_one_time_key",
	organization_id: "organization",
	workload_id: "workload",
	workload_name: "Dirac",
	key_name: "Dirac key",
}

describe("Unbiased device authorization polling", () => {
	afterEach(() => sinon.restore())

	it("reads an in-flight successful response even when the UI cancels", async () => {
		const clock = sinon.useFakeTimers()
		const abort = new AbortController()
		let resolveRequest!: (response: Response) => void
		let calls = 0
		const fetcher: typeof globalThis.fetch = (_input, init) => {
			calls++
			assert.equal(init?.signal, undefined, "an in-flight one-time poll must not be aborted")
			return new Promise<Response>((resolve) => {
				resolveRequest = resolve
			})
		}

		const poll = pollUnbiasedDeviceAuth(grant, { baseUrl: "http://localhost", fetcher, signal: abort.signal })
		await clock.tickAsync(999)
		assert.equal(calls, 0, "sleep before the first poll")
		await clock.tickAsync(1)
		assert.equal(calls, 1)
		abort.abort()
		resolveRequest(new Response(JSON.stringify(issuedToken), { status: 200 }))

		assert.equal((await poll).accessToken, issuedToken.access_token)
		await clock.tickAsync(6_000)
		assert.equal(calls, 1, "never replay a successful poll")
	})

	it("stops after one transport failure without retrying", async () => {
		const clock = sinon.useFakeTimers()
		let calls = 0
		const fetcher: typeof globalThis.fetch = async () => {
			calls++
			throw new Error("connection reset")
		}

		const result = pollUnbiasedDeviceAuth(grant, { baseUrl: "http://localhost", fetcher }).then(
			() => undefined,
			(error: unknown) => error,
		)
		await clock.tickAsync(1_000)
		const error = await result
		assert.ok(error instanceof UnbiasedAuthError)
		assert.equal(error.code, "connection_lost")
		await clock.tickAsync(6_000)
		assert.equal(calls, 1)
	})
})
