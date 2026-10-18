import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { GlobalStateAndSettings, Secrets } from "@/shared/storage/state-keys"
import { GLOBAL_STATE_DEFAULTS, SETTINGS_DEFAULTS } from "@/shared/storage/state-keys"
import { getLatestAnnouncementId } from "@/utils/announcements"
import type { StateManager } from "../StateManager"
import * as taskDirectory from "../taskDirectory"
import { dismissUnbiasedWelcomeOffer, initializeUnbiasedWelcomeOffer } from "../unbiasedWelcomeOffer"

function storage(overrides: Partial<GlobalStateAndSettings> = {}, secrets: Partial<Secrets> = {}) {
	const state = { ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS, ...overrides }
	const flush = sinon.stub().resolves()
	const manager = {
		getGlobalStateKey: (key: keyof GlobalStateAndSettings) => state[key],
		getGlobalSettingsKey: (key: keyof GlobalStateAndSettings) => state[key],
		getSecretKey: (key: keyof Secrets) => secrets[key],
		setGlobalState: (key: keyof GlobalStateAndSettings, value: unknown) => Object.assign(state, { [key]: value }),
		setGlobalStateBatch: (updates: Partial<GlobalStateAndSettings>) => Object.assign(state, updates),
		flushPendingState: flush,
	} as unknown as StateManager
	return { state, flush, manager }
}

describe("Unbiased first-run welcome eligibility", () => {
	let taskDirectories: sinon.SinonStub<[], Promise<string[]>>
	beforeEach(() => {
		taskDirectories = sinon.stub(taskDirectory, "listTaskDirectoryIds").resolves([])
	})
	afterEach(() => sinon.restore())

	it("excludes prior runs even when their history index needs repair", async () => {
		taskDirectories.resolves(["existing-task"])
		const { state, manager } = storage()
		await initializeUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "ineligible")
	})

	it("persists eligibility for a fresh install before its version is recorded", async () => {
		const { state, manager, flush } = storage()
		await initializeUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "pending")
		assert.equal(state.diracVersion, undefined)
		assert.equal(flush.callCount, 1)
	})

	const returningUsers: Array<[string, Partial<GlobalStateAndSettings>]> = [
		["installed version, even with no tasks", { diracVersion: "0.5.20" }],
		["legacy announcement", { lastShownAnnouncementId: "0.4" }],
		["completed onboarding", { welcomeViewCompleted: true }],
		["prior task", { taskHistory: [{ id: "prior-task" }] as GlobalStateAndSettings["taskHistory"] }],
		["established user", { isNewUser: false }],
		[
			"configured local provider",
			{ modelProviderPresets: [{ id: "local" }] as GlobalStateAndSettings["modelProviderPresets"] },
		],
	]
	for (const [description, overrides] of returningUsers) {
		it(`excludes users with ${description}`, async () => {
			const { state, manager } = storage(overrides)
			await initializeUnbiasedWelcomeOffer(manager)
			assert.equal(state.unbiasedWelcomeOfferStatus, "ineligible")
		})
	}

	it("excludes users with saved credentials even when history is empty", async () => {
		const { state, manager } = storage({}, { unbiasedApiKey: "saved-key" })
		await initializeUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "ineligible")
	})

	it("does not mistake an auth nonce or incomplete legacy onboarding for prior use", async () => {
		const { state, manager } = storage({ welcomeViewCompleted: false }, { authNonce: "nonce" })
		await initializeUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "pending")
	})

	for (const status of ["pending", "dismissed", "ineligible"] as const) {
		it(`preserves ${status} across reloads and upgrades`, async () => {
			const { state, manager, flush } = storage({ unbiasedWelcomeOfferStatus: status, diracVersion: "0.5.21" })
			await initializeUnbiasedWelcomeOffer(manager)
			assert.equal(state.unbiasedWelcomeOfferStatus, status)
			assert.equal(flush.callCount, 0)
		})
	}

	it("persists dismissal and consumes the competing announcement", async () => {
		const { state, manager, flush } = storage({
			unbiasedWelcomeOfferStatus: "pending",
			pendingReleaseNotesFromVersion: "0.5.20",
		})
		await dismissUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "dismissed")
		assert.equal(state.lastShownAnnouncementId, getLatestAnnouncementId())
		assert.equal(state.pendingReleaseNotesFromVersion, undefined)
		assert.equal(flush.callCount, 1)
		await initializeUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "dismissed")
	})

	it("does not dismiss returning users' release notes", async () => {
		const { state, manager, flush } = storage({ unbiasedWelcomeOfferStatus: "ineligible", lastShownAnnouncementId: "0.4" })
		await dismissUnbiasedWelcomeOffer(manager)
		assert.equal(state.lastShownAnnouncementId, "0.4")
		assert.equal(flush.callCount, 0)
	})

	it("surfaces persistence failures", async () => {
		const { manager, state, flush } = storage({ unbiasedWelcomeOfferStatus: "pending", lastShownAnnouncementId: "0.4" })
		flush.rejects(new Error("disk full"))
		await assert.rejects(dismissUnbiasedWelcomeOffer(manager), /disk full/)
		assert.equal(state.unbiasedWelcomeOfferStatus, "pending")
		assert.equal(state.lastShownAnnouncementId, "0.4")
		flush.resolves()
		await dismissUnbiasedWelcomeOffer(manager)
		assert.equal(state.unbiasedWelcomeOfferStatus, "dismissed")
		assert.equal(flush.callCount, 2)
	})
})
