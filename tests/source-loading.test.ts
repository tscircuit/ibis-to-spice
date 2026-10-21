import { expect, test } from "bun:test"
import { zipSync, strToU8 } from "fflate"
import { createIbisModelResolver, loadIbisSource, sourceHash } from "../lib"

const source = "[IBIS Ver] 4.2\n[File Name] input.ibs\n[End]\n"
const url = "https://example.test/model.zip"
test("locked ZIP import selects the declared member", async () => {
  const zip = zipSync({
    "input.ibs": strToU8(source),
    "other.ibs": strToU8("wrong"),
  })
  const fakeFetch = async () => new Response(Uint8Array.from(zip).buffer)
  expect(
    await loadIbisSource(
      { sourceUrl: url, archivePath: "input.ibs", sha256: sourceHash(source) },
      fakeFetch,
    ),
  ).toBe(source)
})
test("hash mismatch, missing member and omitted URL hash fail before conversion", async () => {
  const fakeFetch = async () =>
    new Response(
      Uint8Array.from(zipSync({ "input.ibs": strToU8(source) })).buffer,
    )
  await expect(
    loadIbisSource(
      { sourceUrl: url, archivePath: "input.ibs", sha256: "0".repeat(64) },
      fakeFetch,
    ),
  ).rejects.toThrow("does not match")
  await expect(
    loadIbisSource(
      {
        sourceUrl: url,
        archivePath: "missing.ibs",
        sha256: sourceHash(source),
      },
      fakeFetch,
    ),
  ).rejects.toThrow("member is missing")
  await expect(loadIbisSource({ sourceUrl: url }, fakeFetch)).rejects.toThrow(
    "require the SHA-256",
  )
})
test("conflicting source forms are rejected", async () => {
  await expect(loadIbisSource({ source, sourceUrl: url })).rejects.toThrow(
    "exactly one",
  )
})

test("an HTML download is reported as a model error", async () => {
  await expect(
    loadIbisSource(
      { sourceUrl: url, sha256: sourceHash(source) },
      async () =>
        new Response("<html>Blocked</html>", {
          headers: { "content-type": "text/html" },
        }),
    ),
  ).rejects.toThrow("HTML page")
})

test("a resolver shares downloads across chips and retries failed downloads", async () => {
  const text = `[IBIS Ver] 4.2
[Component] Input
[Pin] signal_name model_name
1 IN A
[Model] A
Model_type Input
C_comp 1p 1p 1p
[Voltage Range] 1.5 1.4 1.6
[End]`
  let requests = 0
  const resolve = createIbisModelResolver(async () => {
    requests++
    return requests === 1
      ? new Response("Unavailable", { status: 503 })
      : new Response(text)
  })
  const config = {
    sourceUrl: url,
    sha256: sourceHash(text),
    component: "Input",
    pins: { IN: { pin: "1", mode: "input" as const } },
    power: { vdd: "VDD", vss: "GND" },
    packageModel: "none" as const,
  }
  await expect(resolve(config)).rejects.toThrow("HTTP 503")
  const [a, b] = await Promise.all([resolve(config), resolve(config)])
  expect(requests).toBe(2)
  expect(a).toEqual(b)
})
