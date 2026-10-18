import { Chalk } from "chalk"
import { lexer, type Token, type Tokens } from "marked"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import { styles, theme } from "../constants/theme"
import { linkifyPaths } from "./terminal-link"

// This formatter is for Ink's interactive path; standalone output remains plain text.
const chalk = new Chalk({ level: 3 })

type TextStyle = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean }

function styleText(text: string, style: TextStyle): string {
	let paint = chalk
	if (style.color) paint = paint.hex(style.color)
	if (style.backgroundColor) paint = paint.bgHex(style.backgroundColor)
	if (style.bold) paint = paint.bold
	if (style.italic) paint = paint.italic
	if (style.underline) paint = paint.underline
	return paint(text)
}

function truncateCell(text: string, width: number): string {
	if (width <= 0) return ""
	if (stringWidth(text) <= width) return text
	let result = ""
	for (const { segment } of new Intl.Segmenter().segment(text)) {
		if (stringWidth(result + segment) >= width) break
		result += segment
	}
	return `${result}…`
}

function allocateColumnWidths(naturalWidths: number[], availableWidth: number): number[] {
	const widths = naturalWidths.map((width) => Math.max(1, width))
	const naturalTotal = widths.reduce((sum, width) => sum + width, 0)
	if (naturalTotal <= availableWidth) return widths
	const remainingWidth = Math.max(0, availableWidth - widths.length)
	const expandableTotal = widths.reduce((sum, width) => sum + Math.max(0, width - 1), 0)
	return widths.map((width) => (expandableTotal === 0 ? 1 : 1 + Math.floor(((width - 1) / expandableTotal) * remainingWidth)))
}

function renderTokens(tokens: Token[], width: number, color?: string): string {
	return tokens.map((token) => renderToken(token, width, color)).join("")
}

function renderToken(token: Token, width: number, color?: string): string {
	switch (token.type) {
		case "heading": {
			const { depth, tokens } = token as Tokens.Heading
			const style = depth <= 2 ? styles.markdown.heading : styles.markdown.headingSub
			return `${depth <= 2 ? "\n" : ""}${styleText(renderTokens(tokens, width, color), { ...style, ...(color ? { color } : {}) })}\n${depth === 1 ? "\n" : ""}`
		}
		case "paragraph":
			return `${renderTokens((token as Tokens.Paragraph).tokens, width, color)}\n`
		case "code": {
			const codeWidth = Math.max(1, width - 4)
			const lines = wrapAnsi((token as Tokens.Code).text.replace(/\t/g, "    "), codeWidth, {
				hard: true,
				trim: false,
				wordWrap: false,
			}).split("\n")
			if (width < 5) return `${styleText(lines.join("\n"), styles.markdown.codeBlock)}\n`
			const padWidth = Math.max(...lines.map((line) => stringWidth(line)), 1)
			const border = (text: string) => styleText(text, styles.markdown.codeBorder)
			const body = lines
				.map(
					(line) =>
						`${border("│ ")}${styleText(line + " ".repeat(padWidth - stringWidth(line)), styles.markdown.codeBlock)}${border(" │")}\n`,
				)
				.join("")
			return `\n${border(`┌${"─".repeat(padWidth + 2)}┐`)}\n${body}${border(`└${"─".repeat(padWidth + 2)}┘`)}\n`
		}
		case "list": {
			const { ordered, start, items } = token as Tokens.List
			return items
				.map(
					(item, index) =>
						`${styleText(ordered ? `${Number(start ?? 1) + index}. ` : "• ", { color: theme.muted })}${renderTokens(item.tokens, width, color)}\n`,
				)
				.join("")
		}
		case "blockquote":
			return `${styleText("│ ", styles.markdown.blockquoteBar)}${renderTokens((token as Tokens.Blockquote).tokens, width, color)}`
		case "space":
			return "\n"
		case "strong":
			return styleText(renderTokens((token as Tokens.Strong).tokens, width, color), {
				...styles.markdown.strong,
				...(color ? { color } : {}),
			})
		case "em":
			return styleText(renderTokens((token as Tokens.Em).tokens, width, color), {
				...styles.markdown.emphasis,
				...(color ? { color } : {}),
			})
		case "codespan":
			return styleText(linkifyPaths((token as Tokens.Codespan).text), styles.markdown.inlineCode)
		case "link": {
			const { text, href } = token as Tokens.Link
			return styleText(text && text !== href ? `${text} (${href})` : href, styles.markdown.link)
		}
		case "text": {
			const { text, tokens } = token as Tokens.Text
			return tokens?.length ? renderTokens(tokens, width, color) : styleText(linkifyPaths(text), { color })
		}
		case "hr":
			return `${styleText("─".repeat(width), styles.markdown.hr)}\n`
		case "table": {
			const { header, rows } = token as Tokens.Table
			const headerTexts = header.map((cell) => cell.text)
			const rowTexts = rows.map((row) => row.map((cell) => cell.text))
			const naturalWidths = headerTexts.map((text, column) =>
				Math.max(stringWidth(text), ...rowTexts.map((row) => stringWidth(row[column] || ""))),
			)
			const available = width - naturalWidths.length * 3 - 1
			if (available < naturalWidths.length) {
				return [headerTexts, ...rowTexts]
					.map(
						(row, index) =>
							`${styleText(truncateCell(row.join(" | "), width), { ...(index === 0 ? styles.markdown.tableHeader : {}), ...(color ? { color } : {}) })}\n`,
					)
					.join("")
			}
			const widths = allocateColumnWidths(naturalWidths, available)
			const border = (left: string, middle: string, right: string) =>
				`${styleText(left + widths.map((column) => "─".repeat(column + 2)).join(middle) + right, styles.markdown.tableBorder)}\n`
			const row = (cells: string[]) =>
				"│" +
				cells
					.map((cell, column) => {
						const text = truncateCell(cell, widths[column])
						return ` ${text}${" ".repeat(widths[column] - stringWidth(text))} `
					})
					.join("│") +
				"│"
			return (
				border("┌", "┬", "┐") +
				styleText(row(headerTexts), { ...styles.markdown.tableHeader, ...(color ? { color } : {}) }) +
				"\n" +
				border("├", "┼", "┤") +
				rowTexts.map((cells) => `${styleText(row(cells), { color })}\n`).join("") +
				border("└", "┴", "┘")
			)
		}
		case "escape":
			return styleText((token as Tokens.Escape).text, { color })
		case "image": {
			const { text, href } = token as Tokens.Image
			return styleText(text ? `[${text}] (${href})` : href, { color })
		}
		case "br":
			return "\n"
		default:
			return "raw" in token ? styleText(token.raw, { color }) : ""
	}
}

/** Parse the whole document before wrapping or clipping; rows carry independent ANSI styles. */
export function renderMarkdownLines(markdown: string, columns: number, color?: string): string[] {
	const width = Math.max(1, columns)
	const rendered = renderTokens(lexer(markdown), width, color).replace(/\n$/, "")
	return wrapAnsi(rendered, width, { hard: true, trim: false }).split("\n")
}

export function clipMarkdownLines(
	lines: string[],
	maxLines: number,
	scrollFromBottom = 0,
): { visibleText: string; hasMoreAbove: boolean; hasMoreBelow: boolean } {
	const budget = Math.max(1, maxLines)
	const maxScroll = Math.max(0, lines.length - budget)
	const end = lines.length - Math.min(Math.max(0, scrollFromBottom), maxScroll)
	const start = Math.max(0, end - budget)
	return { visibleText: lines.slice(start, end).join("\n"), hasMoreAbove: start > 0, hasMoreBelow: end < lines.length }
}
