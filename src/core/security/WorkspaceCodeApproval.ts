import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import Mutex from "p-mutex"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { atomicWriteFile } from "@core/storage/atomicWrite"

/** A grant is for these exact bytes at this path and target, never for a repository or tool ID alone. */
export interface WorkspaceCodeSnapshot {
	readonly source: Buffer
	readonly manifestSource?: Buffer
	readonly digest: string
	readonly target: string
}

const approvalMutex = new Mutex()
const APPROVE = "Trust and run this code"
const REVIEW = "Review source"

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function fingerprint(workspaceRoot: string, entrypoint: string, manifest?: string): Promise<{ key: string; snapshot: WorkspaceCodeSnapshot }> {
	const lexicalRoot = path.resolve(workspaceRoot)
	const root = await fs.realpath(lexicalRoot)
	const entry = path.resolve(entrypoint)
	if (!inside(lexicalRoot, entry)) throw new Error(`Workspace code path escapes its root: ${entry}`)
	const canonicalEntry = path.join(root, path.relative(lexicalRoot, entry))
	const target = await fs.realpath(canonicalEntry)
	if (!inside(root, target)) throw new Error(`Workspace code target escapes its root: ${entry}`)
	const source = await fs.readFile(target)
	const digest = createHash("sha256")
	let manifestSource: Buffer | undefined
	if (manifest) {
		const manifestPath = path.resolve(manifest)
		if (!inside(lexicalRoot, manifestPath)) throw new Error(`Workspace tool manifest escapes its root: ${manifestPath}`)
		const manifestTarget = await fs.realpath(path.join(root, path.relative(lexicalRoot, manifestPath)))
		if (!inside(root, manifestTarget)) throw new Error(`Workspace tool manifest escapes its root: ${manifestPath}`)
		manifestSource = await fs.readFile(manifestTarget)
		digest.update(manifestSource).update("\0")
	}
	digest.update(source)
	const hex = digest.digest("hex")
	return { key: JSON.stringify([root, path.relative(root, canonicalEntry), target, hex]), snapshot: { source, manifestSource, target, digest: hex } }
}

async function grantsPath(): Promise<string> {
	const directory = path.join(HostProvider.get().globalStorageFsPath, "security")
	await fs.mkdir(directory, { recursive: true })
	return path.join(directory, "workspace-code-grants.json")
}

async function readGrants(file: string): Promise<string[]> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as string[]
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/** Reading the candidate never evaluates code. Interactive approval is only offered when explicitly requested. */
export async function approvedWorkspaceCode(
	workspaceRoot: string,
	entrypoint: string,
	manifest?: string,
	prompt = false,
): Promise<WorkspaceCodeSnapshot | undefined> {
	return approvalMutex.withLock(async () => {
		const { key, snapshot } = await fingerprint(workspaceRoot, entrypoint, manifest)
		const file = await grantsPath()
		const grants = await readGrants(file)
		if (!HostProvider.get().isWorkspaceTrusted()) return undefined
		if (grants.includes(key)) return snapshot
		if (!prompt || HostProvider.get().diracType !== "extension") return undefined
		const [root, relative, target, digest] = JSON.parse(key) as string[]
		const decision = await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `Trust workspace code: ${relative}?`,
			options: {
				modal: true,
				items: [REVIEW, APPROVE],
				detail: `Workspace: ${root}\nResolved target: ${target}\nSHA-256: ${digest}\nOnly these exact file contents will be trusted. Review the code before approving.`,
			},
		})
		if (decision.selectedOption === REVIEW) {
			await HostProvider.window.showTextDocument({ path: target })
			return undefined
		}
		if (decision.selectedOption !== APPROVE) return undefined
		// A checkout may have changed while the modal was open. Never grant approval for unseen bytes.
		const current = await fingerprint(workspaceRoot, entrypoint, manifest)
		if (current.key !== key) return undefined
		await atomicWriteFile(file, JSON.stringify([...grants, key]))
		return current.snapshot
	})
}
