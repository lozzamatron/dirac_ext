import type { EmptyRequest } from "@shared/proto/dirac/common"
import { Empty } from "@shared/proto/dirac/common"
import { dismissUnbiasedWelcomeOffer as persistOfferDismissal } from "@/core/storage/unbiasedWelcomeOffer"
import type { Controller } from "../index"

export async function dismissUnbiasedWelcomeOffer(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	await persistOfferDismissal(controller.stateManager)
	await controller.postStateToWebview()
	return Empty.create({})
}
