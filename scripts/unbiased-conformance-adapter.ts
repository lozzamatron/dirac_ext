// Run from the partner kit: npx tsx run.ts --adapter /path/to/dirac/scripts/unbiased-conformance-adapter.ts
import {
	startUnbiasedDeviceAuth,
	pollUnbiasedDeviceAuth,
	UnbiasedAuthError,
	type UnbiasedDeviceGrant,
} from "../src/integrations/unbiased/device-auth"

const adapter = {
	name: "Dirac",
	async start({ baseUrl, clientId, deviceName }: { baseUrl: string; clientId: string; deviceName: string | null }) {
		try {
			const grant = await startUnbiasedDeviceAuth(deviceName, { baseUrl, clientId })
			return { ok: true, grant }
		} catch (error) {
			return { ok: false, code: error instanceof UnbiasedAuthError ? error.code : "connection_lost" }
		}
	},
	async poll({ baseUrl, clientId, grant }: { baseUrl: string; clientId: string; grant: UnbiasedDeviceGrant }) {
		try {
			const token = await pollUnbiasedDeviceAuth(grant, { baseUrl, clientId })
			return { ok: true, ...token }
		} catch (error) {
			return { ok: false, code: error instanceof UnbiasedAuthError ? error.code : "connection_lost" }
		}
	},
}

export default adapter
