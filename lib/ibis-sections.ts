export interface Section {
  key: string
  argument: string
  body: string
}
export function parseIbisSections(text: string): Section[] {
  const headers = [
    ...text.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*([^\r\n]*)/gm),
  ]
  return headers.map((header, index) => ({
    key: header[1]
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, " "),
    argument: header[2].split("|")[0].trim(),
    body: text.slice(
      header.index + header[0].length,
      headers[index + 1]?.index || text.length,
    ),
  }))
}
export function stripIbisCommentLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.split("|")[0].trim())
    .filter(Boolean)
}
