import { cn } from "@heroui/react"
import { StringRequest } from "@shared/proto/dirac/common"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

const CopyTaskButton: React.FC<{
	taskText?: string
	className?: string
}> = ({ taskText, className }) => {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(async () => {
		if (!taskText) return

		try {
			await FileServiceClient.copyToClipboard(StringRequest.create({ value: taskText }))
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch (error) {
			setCopied(false)
			console.error("Copy failed", error)
		}
	}, [taskText])

	return (
		<Tooltip>
			<TooltipContent side="bottom">Copy Text</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label="Copy"
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						handleCopy()
					}}
					size="icon"
					variant="icon">
					{copied ? <CheckIcon /> : <CopyIcon />}
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default CopyTaskButton
