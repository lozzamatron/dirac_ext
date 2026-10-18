import { setTimeout as sleep } from "node:timers/promises"

// Unbiased's public OAuth device grant. Never retry a token poll: a replay after
// successful issuance revokes the key. Keep this transport independent of UI and storage.
export const UNBIASED_CLIENT_ID = "ACp6F_HOTbenBcuhp5fjjQ"
export const UNBIASED_PLATFORM_URL = "https://platform.unbiased.ai"
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

export interface UnbiasedDeviceGrant {
	deviceCode: string
	userCode: string
	verificationUri: string
	verificationUriComplete: string
	expiresIn: number
	interval: number
}

export interface UnbiasedDeviceToken {
	accessToken: string
	organizationId: string
	workloadId: string
	workloadName: string
	keyName: string
}

export class UnbiasedAuthError extends Error {
	constructor(readonly code: string) {
		super(
			{
				invalid_client: "This build is not registered for Unbiased sign-in. Please update Dirac.",
				access_denied: "Sign-in was declined in the browser.",
				expired_token: "The sign-in code expired. Start again.",
				connection_lost: "Lost the connection while waiting for approval. Start sign-in again.",
				invalid_response: "Unbiased returned an invalid sign-in response. Start again; do not retry this code.",
				invalid_grant: "Sign-in code is no longer valid. Start again.",
				cancelled: "Sign-in cancelled.",
			}[code] ?? `Unbiased sign-in failed (${code}). Start again.`,
		)
	}
}

interface DeviceAuthOptions {
	baseUrl?: string
	clientId?: string
	fetcher?: typeof globalThis.fetch
	signal?: AbortSignal
}

async function postDeviceAuth(
	baseUrl: string,
	fetcher: typeof globalThis.fetch,
	path: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
	const response = await fetcher(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		signal,
	})
	// Body decoding is part of the one-shot poll. A malformed 200 must NOT be retried.
	const body: unknown = await response.json().catch(() => null)
	return { status: response.status, body: body && typeof body === "object" ? (body as Record<string, unknown>) : null }
}

export async function startUnbiasedDeviceAuth(
	deviceName: string | null,
	options: DeviceAuthOptions = {},
): Promise<UnbiasedDeviceGrant> {
	const { baseUrl = UNBIASED_PLATFORM_URL, clientId = UNBIASED_CLIENT_ID, fetcher = globalThis.fetch, signal } = options
	let response: Awaited<ReturnType<typeof postDeviceAuth>>
	try {
		response = await postDeviceAuth(
			baseUrl,
			fetcher,
			"/api/oauth/device_authorization",
			{
				client_id: clientId,
				...(deviceName ? { device_name: deviceName.slice(0, 100) } : {}),
			},
			signal,
		)
	} catch {
		throw new UnbiasedAuthError(signal?.aborted ? "cancelled" : "connection_lost")
	}
	if (response.status !== 200) throw new UnbiasedAuthError(String(response.body?.error ?? response.status))
	const grant = response.body
	if (
		typeof grant?.device_code !== "string" ||
		typeof grant.user_code !== "string" ||
		typeof grant.verification_uri !== "string" ||
		typeof grant.verification_uri_complete !== "string" ||
		typeof grant.expires_in !== "number" ||
		typeof grant.interval !== "number"
	) {
		throw new UnbiasedAuthError("invalid_response")
	}
	return {
		deviceCode: grant.device_code,
		userCode: grant.user_code,
		verificationUri: grant.verification_uri,
		verificationUriComplete: grant.verification_uri_complete,
		expiresIn: grant.expires_in,
		interval: grant.interval,
	}
}

export async function pollUnbiasedDeviceAuth(
	grant: UnbiasedDeviceGrant,
	options: DeviceAuthOptions = {},
): Promise<UnbiasedDeviceToken> {
	const { baseUrl = UNBIASED_PLATFORM_URL, clientId = UNBIASED_CLIENT_ID, fetcher = globalThis.fetch, signal } = options
	const expiresAt = Date.now() + grant.expiresIn * 1000
	let interval = Math.max(1, grant.interval)
	while (true) {
		if (signal?.aborted) throw new UnbiasedAuthError("cancelled")
		try {
			await sleep(interval * 1000, undefined, { signal })
		} catch {
			throw new UnbiasedAuthError("cancelled")
		}
		if (signal?.aborted) throw new UnbiasedAuthError("cancelled")
		if (Date.now() >= expiresAt) throw new UnbiasedAuthError("expired_token")
		let response: Awaited<ReturnType<typeof postDeviceAuth>>
		try {
			// Once dispatched, let the one-shot response finish even if the UI cancels.
			// Aborting a successful response before reading its body could lose an issued key.
			response = await postDeviceAuth(baseUrl, fetcher, "/api/oauth/token", {
				grant_type: GRANT_TYPE,
				device_code: grant.deviceCode,
				client_id: clientId,
			})
		} catch {
			throw new UnbiasedAuthError("connection_lost")
		}
		// A 200 may have issued a key even if cancellation raced with its response.
		// Keep and persist the key rather than discarding it after a successful poll.
		const body = response.body
		if (response.status === 200) {
			if (
				typeof body?.access_token !== "string" ||
				typeof body.organization_id !== "string" ||
				typeof body.workload_id !== "string" ||
				typeof body.workload_name !== "string" ||
				typeof body.key_name !== "string"
			)
				throw new UnbiasedAuthError("invalid_response")
			return {
				accessToken: body.access_token,
				organizationId: body.organization_id,
				workloadId: body.workload_id,
				workloadName: body.workload_name,
				keyName: body.key_name,
			}
		}
		const error = String(body?.error ?? response.status)
		if (error === "slow_down") {
			interval += 5
			continue
		}
		if (error === "authorization_pending" || error === "temporarily_unavailable") continue
		throw new UnbiasedAuthError(error)
	}
}
