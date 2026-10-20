import assert from "node:assert/strict";
import { businessIds, documentIds } from "./contract.mjs";

// Customer inventory now registers a governed-read Agent. The two mock order
// previews still must not appear in the initial model preset roster.
export const currentBusinessIds = [...businessIds, "gea-html-inventory-customer"];
export const currentDocumentIds = [...documentIds, "gea-html-inventory-customer"];
export function validateInitialPresets(presets) {
  for (const id of currentBusinessIds) {
    const matches = presets.filter((row) => row.id === id);
    assert(
      matches.length === 1 && !matches[0].broken,
      `BUSINESS_PRESET_NOT_DISCOVERABLE_BEFORE_SELECTION:${id}`,
    );
  }
  for (const id of ["gea-html-inventory-orderworkbench", "gea-html-inventory-orderfulfillment"])
    assert(!presets.some((row) => row.id === id), `PREVIEW_PRESET_VISIBLE:${id}`);
}
