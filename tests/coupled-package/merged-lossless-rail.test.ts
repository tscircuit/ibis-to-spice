import { test } from "bun:test";
import assert from "node:assert/strict";
import createEngine from "@tscircuit/ngspice-spice-engine";
import { convertIbisModelToSpice } from "../../lib";
import { packageInput, source } from "../fixtures/coupled-package";

test("ngspice biases both die references through one lossless merged rail", async () => {
	const { definition, run } = packageInput(true);
	const lossless = source
		.replace(
			"[Model] input",
			`V2 VDD2 POWER
[Pin Mapping] pulldown_ref pullup_ref gnd_clamp_ref power_clamp_ref
A1 GND PWR GND PWR
B1 GND PWR GND PWR
G1 GND NC GND NC
V1 NC NC NC PWR
V2 NC NC NC PWR
[Model] input`,
		)
		.replace(
			source.slice(
				source.indexOf("[Resistance Matrix]"),
				source.indexOf("[Inductance Matrix]"),
			),
			"",
		);
	const engine = await createEngine();
	for (const mergedPins of ["", "[Merged Pins] V1\nV2\n"]) {
		const converted = convertIbisModelToSpice(
			lossless
				.replace("[Model Data]", `${mergedPins}[Model Data]`)
				.replace(
					"[Define Package Model]",
					"[Power Clamp]\n-1.5 .03 .03 .03\n0 0 0 0\n1.5 -.03 -.03 -.03\n[Define Package Model]",
				),
			{
				...definition,
				references: {
					A1: { pullup: "VDD", powerClamp: "VDD" },
					B1: { pullup: "VDD2", powerClamp: "VDD2" },
				},
			},
			run,
		);
		assert.deepEqual(converted.metadata.packageData.matrices?.mergedPins, {
			V2: "V1",
		});
		assert.doesNotMatch(converted.source, /^VDIE/m);
		assert.deepEqual(converted.metadata.packageData.boardPortAliases, {
			VDD2: "VDD",
		});
		assert.ok(!Object.values(converted.spicePinMapping).includes("VDD2"));
		for (const index of [0, 1])
			assert.match(
				converted.source,
				new RegExp(`^XBUF${index} PKGD${index} PKGD2 PKGD3 PKGD2 PKGD3 `, "m"),
			);
		const name = converted.source.match(/^\.subckt (\S+)/m)?.[1];
		assert.ok(name);
		const boardNodes: Record<string, string> = {
			A: "in_a",
			B: "in_b",
			VSS: "0",
			VDD: "vdd",
		};
		const terminals = Object.values(converted.spicePinMapping).map(
			(port) => boardNodes[port],
		);
		const deck = [
			"Lossless merged rail with a board supply",
			converted.source,
			`XU ${terminals.join(" ")} ${name}`,
			"VDD vdd 0 1.5",
			"VA in_a 0 0",
			"VB in_b 0 0",
			".save all i(vdd) v(xu.pkgd2)",
			".tran 50p 1n",
			".end",
		].join("\n");
		const { simulationResultCircuitJson } = await engine.simulate(deck);
		const bias = simulationResultCircuitJson.find(
			(item) =>
				item.type === "simulation_transient_voltage_graph" &&
				item.name === "xu.pkgd2",
		);
		assert.ok(bias?.type === "simulation_transient_voltage_graph");
		const dieVolts = bias.voltage_levels.at(-1);
		assert.ok(dieVolts !== undefined && Math.abs(dieVolts - 1.5) < 30e-6);
		const current = simulationResultCircuitJson.find(
			(item) =>
				item.type === "simulation_transient_current_graph" &&
				item.name === "vdd",
		);
		assert.ok(current?.type === "simulation_transient_current_graph");
		const currentAmperes = current.current_levels.at(-1);
		assert.ok(
			currentAmperes !== undefined &&
				Math.abs(currentAmperes + (2 * 1.5) / 50) < 1e-8,
			`I(VDD)=${currentAmperes}, V(die)=${dieVolts}`,
		);
	}
});
