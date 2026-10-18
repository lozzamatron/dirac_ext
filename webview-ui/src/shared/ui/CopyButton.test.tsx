import { Empty } from "@shared/proto/dirac/common"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { CopyButton, WithCopyButton } from "./CopyButton"

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("CopyButton", () => {
	it("writes message text through the host before showing success", async () => {
		let finishCopy!: () => void
		const copy = vi.spyOn(FileServiceClient, "copyToClipboard").mockImplementation(
			() =>
				new Promise((resolve) => {
					finishCopy = () => resolve(Empty.create())
				}),
		)
		render(
			<WithCopyButton textToCopy="hello **world**">
				<p>Message</p>
			</WithCopyButton>,
		)

		const button = screen.getByRole("button", { name: "Copy" })
		expect(button.parentElement).toHaveClass("z-10")
		fireEvent.click(button)
		expect(copy).toHaveBeenCalledWith(expect.objectContaining({ value: "hello **world**" }))
		expect(button).toHaveAccessibleName("Copy")

		finishCopy()
		await waitFor(() => expect(button).toHaveAccessibleName("Copied"))
	})

	it("copies code provided by onCopy and reports failures without showing success", async () => {
		const copy = vi.spyOn(FileServiceClient, "copyToClipboard").mockRejectedValue(new Error("clipboard unavailable"))
		const error = vi.spyOn(console, "error").mockImplementation(vi.fn())
		const getCode = vi.fn(() => "const x = 1")
		render(<CopyButton ariaLabel="Copy code" onCopy={getCode} />)

		fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
		await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument())
		expect(copy).toHaveBeenCalledWith(expect.objectContaining({ value: "const x = 1" }))
		expect(getCode).toHaveBeenCalledOnce()
		expect(error).toHaveBeenCalledOnce()
	})
})
