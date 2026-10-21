import { unzipSync } from "fflate"
import { convertIbisComponentToSpice, sourceHash } from "./convert"
import { IbisError } from "./parse-ibis"
import type { IbisModelConfig, IbisSource } from "./types"
import { validateIbisDefinitionSource } from "./validate-source"

const MAX_BYTES = 64 * 1024 * 1024
export type IbisFetch = (url: string) => Promise<Response>
export async function loadIbisSource(
  config: Pick<
    IbisModelConfig,
    "source" | "sourceUrl" | "sha256" | "archivePath"
  >,
  fetcher: IbisFetch = fetch,
): Promise<string> {
  if (Boolean(config.source) === Boolean(config.sourceUrl))
    throw new IbisError(
      "invalid_source",
      "Provide exactly one of source or sourceUrl",
    )
  if (config.source) {
    if (
      config.sha256 &&
      sourceHash(config.source) !== config.sha256.toLowerCase()
    )
      throw new IbisError(
        "hash_mismatch",
        "Inline IBIS source does not match sha256",
      )
    return config.source
  }
  if (!/^https?:\/\//.test(config.sourceUrl!))
    throw new IbisError("invalid_url", "IBIS sourceUrl must use HTTP or HTTPS")
  if (!/^[a-f0-9]{64}$/i.test(config.sha256 ?? ""))
    throw new IbisError(
      "missing_hash",
      "URL-based IBIS models require the SHA-256 of the .ibs bytes",
    )
  const response = await fetcher(config.sourceUrl!)
  if (!response.ok)
    throw new IbisError(
      "download_failed",
      `IBIS download failed with HTTP ${response.status}`,
    )
  if (/text\/html/i.test(response.headers.get("content-type") ?? ""))
    throw new IbisError(
      "invalid_ibis",
      "IBIS source returned an HTML page instead of a model file",
    )
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES)
    throw new IbisError("source_too_large", "IBIS download exceeds 64 MiB")
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  let sourceBytes: Uint8Array = bytes
  if (isZip) {
    if (!config.archivePath)
      throw new IbisError(
        "missing_archive_path",
        "ZIP sources require an explicit archivePath",
      )
    const archive = unzipSync(bytes, {
      filter: (entry) =>
        entry.name === config.archivePath && entry.originalSize <= MAX_BYTES,
    })
    sourceBytes = archive[config.archivePath]
    if (!sourceBytes)
      throw new IbisError(
        "missing_archive_member",
        "Selected IBIS archive member is missing or exceeds 64 MiB",
      )
  } else if (config.archivePath)
    throw new IbisError(
      "invalid_archive",
      "archivePath was provided for a non-ZIP source",
    )
  if (sourceHash(sourceBytes) !== config.sha256!.toLowerCase())
    throw new IbisError(
      "hash_mismatch",
      "Downloaded IBIS file does not match sha256",
    )
  return new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes)
}

export async function resolveIbisModel(
  config: IbisModelConfig,
  fetcher?: IbisFetch,
) {
  const source = await loadIbisSource(config, fetcher)
  return {
    ...convertIbisComponentToSpice(source, config),
    sourceSha256: sourceHash(source),
  }
}

/** A caller-owned resolver deduplicates pinned source downloads, not simulation choices. */
export function createIbisModelResolver(fetcher: IbisFetch = fetch) {
  const sources = new Map<string, Promise<string>>()
  return async (config: IbisModelConfig) => {
    if (config.source) return resolveIbisModel(config, fetcher)
    const key = JSON.stringify([
      config.sourceUrl,
      config.archivePath,
      config.sha256?.toLowerCase(),
    ])
    let pending = sources.get(key)
    if (!pending) {
      pending = loadIbisSource(config, fetcher)
      sources.set(key, pending)
      pending.catch(() => sources.delete(key))
    }
    const source = await pending
    return {
      ...convertIbisComponentToSpice(source, config),
      sourceSha256: sourceHash(source),
    }
  }
}

/** File paths are resolved/read by the project host, keeping this loader browser usable. */
export async function loadIbisDefinitionSource(
  source: IbisSource,
  options: { fetcher?: IbisFetch; readFile?: (path: string) => Promise<Uint8Array> } = {},
): Promise<string> {
  validateIbisDefinitionSource(source)
  if (source.content !== undefined) {
    if (new TextEncoder().encode(source.content).length > MAX_BYTES) throw new IbisError("source_too_large", "IBIS text exceeds 64 MiB")
    if (source.sha256 && sourceHash(source.content) !== source.sha256.toLowerCase()) throw new IbisError("hash_mismatch", "Inline IBIS source does not match sha256")
    return source.content
  }
  let bytes: Uint8Array
  if (source.file !== undefined) {
    if (!options.readFile) throw new IbisError("missing_file_reader", "File IBIS sources require the host's project-relative file reader")
    bytes = await options.readFile(source.file)
  } else {
    if (!/^https?:\/\//.test(source.url!)) throw new IbisError("invalid_url", "IBIS source URL must use HTTP or HTTPS")
    const response = await (options.fetcher ?? fetch)(source.url!)
    if (!response.ok) throw new IbisError("download_failed", `IBIS download failed with HTTP ${response.status}`)
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) throw new IbisError("invalid_ibis", "IBIS URL returned HTML instead of model data")
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (bytes.length > MAX_BYTES) throw new IbisError("source_too_large", "IBIS source exceeds 64 MiB")
  if (source.sha256 && sourceHash(bytes) !== source.sha256.toLowerCase()) throw new IbisError("hash_mismatch", "Original source bytes do not match SHA-256")
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (isZip) {
    if (!source.archive?.member) throw new IbisError("missing_archive_path", "ZIP sources require an explicit archive.member")
    const selected = source.archive.member
    const archive = unzipSync(bytes, { filter: (entry) => entry.name === selected && entry.originalSize <= MAX_BYTES })
    bytes = archive[selected]
    if (!bytes) throw new IbisError("missing_archive_member", "IBIS archive member is missing or exceeds 64 MiB")
    if (source.archive.memberSha256 && sourceHash(bytes) !== source.archive.memberSha256.toLowerCase()) throw new IbisError("member_hash_mismatch", "Extracted archive member does not match SHA-256")
  } else if (source.archive) throw new IbisError("invalid_archive", "archive was provided for a non-ZIP source")
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
}
