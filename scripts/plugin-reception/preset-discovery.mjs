import assert from "node:assert/strict";
import { businessIds, documentIds } from "./contract.mjs";

export const currentBusinessIds = [
  ...businessIds,
  "gea-html-inventory-customer",
  "gea-html-inventory-orderfulfillment",
  "gea-html-inventory-orderworkbench",
];
export const currentDocumentIds = [
  ...documentIds,
  "gea-html-inventory-customer",
  "gea-html-inventory-orderfulfillment",
  "gea-html-inventory-orderworkbench",
];
export function validateInitialPresets(presets) {
  for (const id of currentBusinessIds) {
    const matches = presets.filter((row) => row.id === id);
    assert(
      matches.length === 1 && !matches[0].broken,
      `BUSINESS_PRESET_NOT_DISCOVERABLE_BEFORE_SELECTION:${id}`,
    );
  }
}
