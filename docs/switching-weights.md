# Bounded switching-weight extraction

`lib/convert.ts:switchingWeights` owns Ku/Kd extraction. The signal-integrity
pipeline consumes its weights; it does not derive them. This policy applies
to both converter APIs and their generated distribution.

## Method and sources

[IBIS 3.2, section 6, Rising/Falling Waveform](https://ibis.org/ver3.2/ver3_2.txt)
defines fixture R/L/C/V, typ/min/max columns, a common stimulus time reference
for waveforms of the same edge, and V/T data that includes die capacitance.
With currents positive into the device, the resistive-fixture KCL equations are

```text
Ipu(Vj) Ku + Ipd(Vj) Kd = bj,                         j = 1, 2
bj = (Vfixture_j - Vj)/Rfixture_j - C_comp dVj/dt
     - Ipower_clamp(Vj) - Ignd_clamp(Vj).
```

[Bob Ross, General K-table Extraction Proposal Using SPICE, 2015,
slides 6–10](https://ibis.org/summits/jan15/ross2.pdf) describes the two-load,
two-equation/two-unknown extraction and its capacitance/fixture topology.
His [1997 IBIS-to-SPICE discussion](https://ibis.org/~ibisorg/email/hm/ibis/1993-2001/2375.html)
also explains the independent pullup/pulldown multipliers and sensitivity to
tabulation and differentiation. We do not assume Ku + Kd = 1.

The specification describes source data, not a mandatory extraction algorithm
or a universal [0,1] multiplier bound. The bounds here are a converter modeling
policy: switch each static I/V contribution between off and its full strength
without reversing or amplifying it. They are not a claim that the source file
violates IBIS or that all real transistor behavior fits this approximation.
[IBIS 7.2, Rising/Falling Waveform, p. 106](https://ibis.org/ver7.2/ver7_2.pdf)
expressly leaves numerical treatment of effective die capacitance to tools.

## SN74LVC1G04 investigation

Source: TI SN74LVC1G04 revision 1.4 (2014), `LVC1G04_OUT_33`, typical corner.
The original is downloaded from [TI scem216c](https://www.ti.com/lit/zip/scem216c)
using the existing archive/member hashes in `vendor-fixtures/models.lock.json`.
TI's disclaimer prohibits redistribution without permission. Neither the full
file nor an excerpt is committed; tests read the ignored `.cache/vendors` copy.

No fixture-handling defect was found in this extraction:

- All four fixtures declare 50 ohms and zero C_fixture/L_fixture; DUT parasitics
  default to zero. Nonzero reactive fixtures are rejected, not ignored.
- Fixture voltages are 0 V and 3.3 V at typical; the other corners use the
  declared fixture-voltage and I/V/V/T columns. C_comp is 8.98 pF at typical.
- C_comp current and both clamp currents are included with the KCL signs above.
- The time grid is the union of the two original grids; neither waveform is
  independently shifted or aligned to its output threshold.
- V/T tables are used directly; the required legacy Ramp is not substituted.

The exact algebra solves the tabulated equations, but its unique solution is
outside the switching envelope. An independent KCL calculation reproduces the
minima. Changing the derivative to a centered secant still gives typical Ku/Kd
minima -0.067789/-0.180521. Even omitting capacitance as a diagnostic leaves
negative weights. At the settled rising endpoint, both derivatives are zero
yet the exact solution is Ku=0.9529459434, Kd=-0.0001979897. Thus time
differentiation alone cannot explain the problem. TI's own revision notes
acknowledge AC/DC endpoint mismatch. The dynamic mismatch is also consistent
with the limitations of a constant-C_comp, two-static-I/V topology; this does
not establish a specific error in TI's transistor model or measurement.

## Treatment

Keep the exact solution if both coefficients lie in [0,1]. Otherwise solve

```text
minimize ||A k - b||², subject to 0 <= Ku,Kd <= 1,
A = [[Ipu(V1), Ipd(V1)], [Ipu(V2), Ipd(V2)]].
```

For this convex quadratic with an invertible A, an infeasible exact solution
puts the constrained optimum on the square's boundary. Solve the one-variable
least-squares problem on each of its four edges, restrict that variable to
[0,1], and select the smallest residual. This includes corner optima and avoids
an iterative optimizer. Existing singular/nonfinite diagnostics remain.
This constrained least-squares extension is our policy, not an algorithm
prescribed by the cited specification or presentations.

This differs from independently clipping the exact coefficients: refitting the
other coefficient lowers current error. On the typical LVC rising/falling
union-grid samples, combined two-fixture current RMS is 2.746/2.584 mA versus
3.129/3.340 mA for independent clipping. General API metadata records
`switchingWeightPolicy: "bounded-least-squares"`.

## Measured limits and validation

Typical coefficients over both edges:

| Coefficient | Exact extraction | Bounded extraction |
| --- | --- | --- |
| Ku | [-0.065768007921, 1.007418804037] | [0, 1] |
| Kd | [-0.172649925905, 1.003244346073] | [0, 1] |

All three LVC corners pass the bound regression. Analytic TSX-source tests
check feasible independent coefficients, all four bound optima, and corner
optima using independent known solutions. No hand-authored Circuit JSON is used.

Bounds sacrifice exact vendor fixture recovery. In the existing typical LVC
general-API simulation, maximum RMS rises from 3.1010 mV to 75.0568 mV; bounded
peak error is 155.4740 mV. The revised test explicitly budgets 80 mV RMS and
160 mV peak. These are regression limits for this approximation, not IBIS
accuracy guarantees. Steady-state/startup and logical-pattern checks remain.

The 72-case TI AM335x/Winbond proof runs now have worst RMS 45.2576 mV
(2.8735% of supply) and worst peak 107.5116 mV (6.8261%). The former 1% RMS/5%
peak acceptance cannot be retained with these bounded coefficients. The proof
now explicitly records a 3% RMS/7% peak budget and the extraction policy.
Its results establish bounded fixture approximation, not the old accuracy claim.
Replaying the same 72 cases with the original unbounded extraction gives worst
RMS 2.7604 mV and peak 20.9289 mV, within its original acceptance limits.

Run `bun run fixtures:fetch`, `bun run typecheck`, `bun test`,
`bun run prove`, `bun run build`, and `bun run test:package`.
This change does not verify the signal-integrity pipeline's package rails,
board waveform accuracy, section convergence, or full-run completion.
