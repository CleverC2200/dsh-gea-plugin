import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FC_DMS_DEFAULT_PICKUP_SQL } from "../src/host/fc-dms-target.ts";

function resolve(
  links,
  master = [
    ["02", "华东"],
    ["37", "遂平"],
  ],
) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE agents_dim_dealer_data_d (cust_code TEXT,pickup_point_code TEXT,pickup_point_name TEXT)",
    );
    db.exec(
      "CREATE TABLE agents_dim_pickup_point_data_d (pickup_point_code TEXT,pickup_point_name TEXT)",
    );
    const dealer = db.prepare("INSERT INTO agents_dim_dealer_data_d VALUES (?,?,?)");
    const pickup = db.prepare("INSERT INTO agents_dim_pickup_point_data_d VALUES (?,?)");
    for (const link of links) dealer.run("C1", ...link);
    for (const row of master) pickup.run(...row);
    return db.prepare(FC_DMS_DEFAULT_PICKUP_SQL).get({ gea_p1: "C1" }).pup_code;
  } finally {
    db.close();
  }
}

test("normal and swapped pairs resolve only against the published master", () => {
  assert.equal(resolve([["02", "华东"]]), "02");
  assert.equal(resolve([["遂平", "37"]]), "37");
});
test("duplicate SKU master rows do not create ambiguity", () => {
  assert.equal(
    resolve(
      [
        ["02", "华东"],
        ["02", "华东"],
      ],
      [
        ["02", "华东"],
        ["02", "华东"],
      ],
    ),
    "02",
  );
});
test("two codes or incomplete relations remain unknown", () => {
  assert.equal(
    resolve([
      ["02", "华东"],
      ["37", "遂平"],
    ]),
    null,
  );
  assert.equal(
    resolve([
      ["02", "华东"],
      ["bad", "37"],
    ]),
    null,
  );
  assert.equal(resolve([["02", null]]), null);
});
test("wrong pairs and absent relationships are not guessed", () => {
  assert.equal(resolve([["02", "遂平"]]), null);
  assert.equal(resolve([]), null);
});
