import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	convertIbisModelToSpice,
	type IbisModelDefinition,
	type IbisRunConfig,
} from "../../lib";
import { vendorSource } from "../vendor-fixtures";

test("scalar vendor packages preserve the die buffer and switching controls", () => {
	const stimulus = {
		unitInterval: "4us",
		startTime: "0ns",
		initialState: 0,
		pattern: { type: "bits", bits: "01", repeat: true },
	} as const;
	const cases: Array<{
		file: string;
		definition: Pick<
			IbisModelDefinition,
			"component" | "pinMap" | "modelSelections"
		>;
		run: Pick<IbisRunConfig, "pinStates" | "stimuli">;
	}> = [
		{
			file: "sn74lvc1g04.ibs",
			definition: {
				component: "LVC1G04_DCK",
				pinMap: { "4": "Y", "5": "VCC", "3": "GND" },
				modelSelections: { "4": "LVC1G04_OUT_33" },
			},
			run: {
				pinStates: { Y: { mode: "output", enabled: true } },
				stimuli: { Y: stimulus },
			},
		},
		{
			file: "sn65hvd72.ibs",
			definition: {
				component: "SN65HVD72D",
				pinMap: { "6": "A", "7": "B", "8": "VCC", "5": "GND" },
			},
			run: {
				pinStates: {
					A: { mode: "output", enabled: true },
					B: { mode: "output", enabled: true },
				},
				stimuli: { A: stimulus, B: { ...stimulus, inverted: true } },
			},
		},
	];
	for (const fixture of cases) {
		const content = vendorSource(fixture.file);
		const definition: IbisModelDefinition = {
			...fixture.definition,
			source: { content },
			corner: "typical",
			packagePolicy: "vendor",
		};
		const run = { ...fixture.run, duration: "8us" };
		const packaged = convertIbisModelToSpice(content, definition, run);
		const die = convertIbisModelToSpice(
			content,
			{ ...definition, packagePolicy: "omit" },
			run,
		);
		assert.deepEqual(packaged.metadata.omissions, []);
		assert.deepEqual(packaged.spicePinMapping, die.spicePinMapping);
		const dieLines = /^((?:XBUF|VKU|VKD).+)$/gm;
		const terminals = Object.keys(packaged.spicePinMapping);
		const packagedLines = [...packaged.source.matchAll(dieLines)].map(
			([line]) =>
				line
					.replace(/\bPKGL(\d+)\b/g, (_, index) => terminals[Number(index)])
					.replace(/IBIS_[a-f0-9]+_BUF/g, "BUFFER"),
		);
		assert.deepEqual(
			packagedLines,
			[...die.source.matchAll(dieLines)].map(([line]) =>
				line.replace(/IBIS_[a-f0-9]+_BUF/g, "BUFFER"),
			),
		);
	}
});
