import { IbisError } from "./parse-ibis"
import type { IbisSource } from "./types"

export function validateIbisDefinitionSource(source: IbisSource): void {
  const forms = [source.url, source.file, source.content].filter((value) => value !== undefined)
  if (forms.length !== 1) throw new IbisError("invalid_source", "Provide exactly one of source.url, source.file or source.content")
  if (source.archive && "sha256" in source.archive) throw new IbisError("invalid_archive", "archive.sha256 is unsupported; use source.sha256 for original bytes and archive.memberSha256 for extracted bytes")
  if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.sha256)) throw new IbisError("invalid_hash", "Original source SHA-256 must contain 64 hex digits")
  if (source.archive?.memberSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.archive.memberSha256)) throw new IbisError("invalid_hash", "Archive member SHA-256 must contain 64 hex digits")
  if (source.content !== undefined && source.archive) throw new IbisError("invalid_source", "Inline IBIS text cannot select a ZIP archive member")
  if (source.archive && !source.archive.member) throw new IbisError("missing_archive_path", "ZIP sources require an explicit archive.member")
  if (source.url !== undefined && !source.sha256) throw new IbisError("missing_hash", "URL-based IBIS models require the original downloaded bytes SHA-256")
}
