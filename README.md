# @tscircuit/ibis-to-spice

Deterministic IBIS electrical-table conversion to ngspice behavioral subcircuits. This source package lives in the normal tscircuit example's workspace; no LLM runs during conversion or simulation. The typed TSX adapter, extraction pipeline and examples are documented by the repository's root README.

From this repository:

```sh
npm install
npm run fixtures:fetch
npm run typecheck
npm test
npm run test:package
```

`prepare` builds the Node ESM API, CLI and bundled declarations during source
installation and before `npm pack`/publication. Packed npm artifacts need no
install scripts or build tools. The declarations are bundled without relative
imports, so strict NodeNext consumers need no declaration rewriting.

For pnpm 11 source dependencies, pin `github:tscircuit/ibis-to-spice#<full-sha>`
or `https://codeload.github.com/tscircuit/ibis-to-spice/tar.gz/<full-sha>`, and
approve preparation in the consuming project's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@tscircuit/ibis-to-spice@git+https://github.com/tscircuit/ibis-to-spice.git': true
```

Use pnpm 11.19 or newer for that repository approval to cover codeload tarballs.
The GitHub API `/repos/.../tarball/...` URL is treated as an ordinary tarball by
pnpm 11.25 and does **not** run `prepare`; use the Git/codeload pin or an npm-packed
artifact instead. Source preparation uses npm and Node; Bun is needed only for
the development tests and vendor scripts. There is intentionally no Bun lockfile:
pnpm otherwise selects Bun to install a Git dependency's build tools.

The tests download original TI AM335x, TI SN65HVD72 RS485, TI SN74LVC1G04 CMOS and Winbond W631GG6MB files. Both archive and extracted-file hashes are pinned in `vendor-fixtures/models.lock.json`. Copyrighted vendor model files remain under ignored `.cache/vendors` and are not redistributed.

## General API

Keep reusable electrical definitions separate from experiment controls:

```ts
import {
  convertIbisModelToSpice,
  loadIbisDefinitionSource,
  type IbisModelDefinition,
} from "@tscircuit/ibis-to-spice"

const definition: IbisModelDefinition = {
  source: {
    url: "https://www.ti.com/lit/zip/sllm183",
    sha256: "935ce893dc388969a3e1319153daaa81e1486d786b87eed6a7d543b5f5dbfcba",
    archive: {
      member: "SN65HVD72_IBIS/sn65hvd72.ibs",
      memberSha256: "293f71f8d6c8764914a73564ebbb5b9e0e706d9dcc18d87aae91f1def06ca47e",
    },
  },
  component: "SN65HVD72D",
  pinMap: { "6": "A", "7": "B", "8": "VCC", "5": "GND" },
  corner: "typical",
  packagePolicy: "omit",
}
const source = await loadIbisDefinitionSource(definition.source)
const stimulus = {
  unitInterval: "4us", startTime: "4us", initialState: 0 as const,
  pattern: { type: "bits" as const, bits: "00111010", repeat: true },
}
const result = convertIbisModelToSpice(source, definition, {
  duration: "40us",
  pinStates: {
    A: { mode: "output", enabled: true },
    B: { mode: "output", enabled: true },
  },
  stimuli: { A: stimulus, B: { ...stimulus, inverted: true } },
})
// result.source: electrical wrapper and internal control PWLs
// result.spicePinMapping: wrapper terminal -> local TSX signal/reference port
// result.metadata: source hash, models, selectors, rails, run states and controls
```

`pinMap` maps physical vendor pins to local TSX ports. `modelSelections` chooses a permitted model for each ambiguous vendor selector. Per-pin `references` may explicitly name pullup, pulldown, power-clamp, ground-clamp and external-reference ports, including ports absent from `pinMap`. Otherwise, inference requires unambiguous mapped vendor power/ground pins or `[Pin Mapping]` networks. Independent rail terminals preserve different reference voltages; callers supply the actual rail sources. Die capacitance is modeled against the pulldown reference. Nonzero supply/reference-pin package impedance is unsupported and makes the vendor package policy fail.

The optional external reference is wired through an independent `EXT_REF` terminal and retained in metadata. IBIS 4.2 defines `[External Reference]` as a receiver-threshold supply, rather than an I/V current return ([specification, section 6](https://ibis.org/ver4.2/ver4_2.txt)). It is a high-impedance terminal here: analog clamp currents and `C_comp` keep their own reference nodes. `[Pin Mapping]` `ext_ref` networks resolve through mapped POWER pins' `pullup_ref` bus, or callers can name the local reference port explicitly. Callers supply its voltage; the converter does not inject the nominal `[External Reference]` voltage or evaluate digital receiver thresholds.

Source forms are exactly one of `url`, `file` or `content`. `source.sha256` verifies the original downloaded, read or inline UTF-8 bytes **before extraction**; URL sources require it. ZIP sources select `archive.member` and can additionally pin the extracted bytes with `archive.memberSha256`. The old `archive.sha256` key is rejected. File sources require a caller-owned `readFile(path)` callback so resolution is relative to the declaring project file. Strings preserve vendor bytes, including CRLF and UTF-8 BOM.

`convertIbisModelToSpice` accepts the already-resolved IBIS bytes: it checks `archive.memberSha256` for an archive definition, or `source.sha256` for a direct definition. The loader owns original archive verification. Returned `sourceSha256` and `metadata.sourceSha256` always identify the IBIS bytes used for conversion, even when `source.sha256` identifies a ZIP file. The legacy `loadIbisSource` API retains its existing checksum contract.

New numeric time inputs are **milliseconds**, matching tscircuit's transient API; strings accept explicit `s`, `ms`, `us`, `ns` and `ps`. Stimuli drive the selected electrical buffer's logical control. Explicit caller inversion applies to the initial state and all pattern bits once; declared vendor `Polarity` applies separately once. Repeated equal bits hold their state without another transition. Nonrepeating bits must cover the run. Missing vendor polarity uses an explicitly reported noninverting pad-control convention; this does not infer a chip's functional truth table. `[Diff Pin]` does not invent another driver or complement a separately controlled leg.

I/V tables use piecewise-linear interpolation and hold the endpoint **current** outside each vendor-supplied voltage domain, consistently in switching extraction and emitted SPICE. Metadata records `tableExtrapolation: "hold-endpoint-current"`. This numerical boundary policy does not clamp pad voltage or validate device behavior beyond the measured table domain. It avoids inventing distant DC roots by extrapolating a declining final segment; the LVC pulldown table, for example, otherwise extrapolates to a false zero-current root near 60.77V on a 3.3V supply. Raw startup and receiver ringing remain in solver output.

Every modeled signal requires a compatible fixed run state. Enabled output requires one stimulus; input and disabled output prohibit stimulus. Fixed drive-enable intent follows vendor `Enable` polarity and is recorded in metadata. Dynamic direction/enable transitions remain unsupported.

## Electrical scope and evidence

Supported selected models are table-based `Input`, `Output`, `I/O` and `3-state`, with clamp I/V tables, `C_comp`, explicit corners and uncoupled signal-pin package R/L/C. Actual output transitions require two independent resistive V/T fixtures per edge. The converter derives switching weights from those tables, clamps, capacitance and fixture currents; the PWL sources control weights, never force output-pad voltages.

`packagePolicy="vendor"` preserves complete declared uncoupled signal-pin R/L/C only when mapped supply/reference-pin package impedances are declared zero. Coupled packages, missing required package data and nonzero supply/reference-pin impedance fail instead of silently downgrading. `omit` explicitly excludes the entire package and records the omission. The real TI and Winbond general-API examples use `omit`: their power/ground pins have nonzero per-pin values or nonzero component defaults. Metadata retains those declared package values, with null marking unavailable data, so the approximation is reviewable. Unsupported selected-model keywords, external/AMI models, series pin mappings, open-drain outputs, split die capacitance, reactive V/T fixtures, ambiguous references and nonzero differential-pair delay fail explicitly. Adjacent actual transitions must be farther apart than the entire measured edge waveform; no tail is silently trimmed. Constant drive needs no switching waveform.

The real SN74LVC1G04 general-API fixture regression measured maximum RMS error **0.0031010076412668944 V** across its original two rising and two falling fixtures. The real SN65HVD72 test executes nonalternating repeated data through two complementary electrical output legs and a 54-ohm differential load. Existing TI/Winbond tests check vendor selectors, static currents, package mapping and local-ground offsets. Fixture agreement establishes consistency with the vendor data used for reconstruction; it does not independently validate silicon, board extraction or protocol compliance.

The lower-level `parseIbis`, `convertIbisBuffer`, `logicalBitSchedule` and `bitWeights` helpers are exported. Legacy `convertIbisComponentToSpice`, `resolveIbisModel` and the CLI remain compatible with the earlier clock configuration; **legacy numeric times remain seconds**. New TSX examples use the general definition/run API.
