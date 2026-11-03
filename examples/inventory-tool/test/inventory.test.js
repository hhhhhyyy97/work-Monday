import test from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_KEY,
  STORAGE_VERSION,
  addItem,
  countLowStock,
  deleteItem,
  exportInventoryJson,
  isLowStock,
  parseStoredInventory,
  searchItems,
  serializeStoredInventory,
  sortItems,
  updateItem,
  validateItemInput,
} from "../inventory.js";

const baseItems = [
  { id: "1", name: "Zinc bolts", sku: "HW-002", quantity: 8, minimumStock: 5 },
  { id: "2", name: "Adhesive tape", sku: "OF-010", quantity: 2, minimumStock: 2 },
  { id: "3", name: "Canvas gloves", sku: "SF-004", quantity: 12, minimumStock: 3 },
];

test("validation trims name and SKU and parses integer values", () => {
  const result = validateItemInput({
    name: "  Safety glasses ",
    sku: " SF-100 ",
    quantity: "4",
    minimumStock: "1",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      name: "Safety glasses",
      sku: "SF-100",
      quantity: 4,
      minimumStock: 1,
    },
  });
});

test("validation rejects missing fields and invalid quantities", () => {
  const missing = validateItemInput({
    name: " ",
    sku: "",
    quantity: "",
    minimumStock: "-1",
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(Object.keys(missing.errors).sort(), [
    "minimumStock",
    "name",
    "quantity",
    "sku",
  ]);

  for (const quantity of ["1.5", "abc", "-1", null]) {
    const result = validateItemInput({
      name: "Washers",
      sku: `SKU-${String(quantity)}`,
      quantity,
      minimumStock: "0",
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.quantity, /nonnegative integer/);
  }
});

test("validation rejects SKUs that differ only by case and whitespace", () => {
  const result = validateItemInput(
    { name: "More tape", sku: " of-010 ", quantity: "8", minimumStock: "1" },
    baseItems,
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.sku, /unique/);
});

test("addItem appends without mutating the input collection", () => {
  const original = structuredClone(baseItems);
  const result = addItem(
    baseItems,
    { name: " Nitrile gloves ", sku: "SF-005", quantity: "20", minimumStock: "4" },
    "4",
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.item, {
    id: "4",
    name: "Nitrile gloves",
    sku: "SF-005",
    quantity: 20,
    minimumStock: 4,
  });
  assert.equal(result.items.length, 4);
  assert.deepEqual(baseItems, original);
  assert.notStrictEqual(result.items, baseItems);
});

test("addItem rejects duplicate SKUs and duplicate IDs", () => {
  const duplicateSku = addItem(
    baseItems,
    { name: "Duplicate", sku: "hw-002", quantity: 1, minimumStock: 0 },
    "new-id",
  );
  assert.equal(duplicateSku.ok, false);
  assert.match(duplicateSku.errors.sku, /unique/);

  const duplicateId = addItem(
    baseItems,
    { name: "Duplicate ID", sku: "NEW-1", quantity: 1, minimumStock: 0 },
    "1",
  );
  assert.equal(duplicateId.ok, false);
  assert.match(duplicateId.errors.id, /unique/);
});

test("updateItem edits the matching item without mutating the input", () => {
  const original = structuredClone(baseItems);
  const result = updateItem(baseItems, "2", {
    name: "Adhesive tape XL",
    sku: "OF-011",
    quantity: "10",
    minimumStock: "3",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.item, {
    id: "2",
    name: "Adhesive tape XL",
    sku: "OF-011",
    quantity: 10,
    minimumStock: 3,
  });
  assert.equal(result.items[1].name, "Adhesive tape XL");
  assert.deepEqual(baseItems, original);
  assert.notStrictEqual(result.items, baseItems);
});

test("updateItem checks duplicate SKUs while excluding the edited item", () => {
  const ownSku = updateItem(baseItems, "2", {
    name: "Adhesive tape",
    sku: "OF-010",
    quantity: "3",
    minimumStock: "2",
  });
  assert.equal(ownSku.ok, true);

  const duplicate = updateItem(baseItems, "2", {
    name: "Adhesive tape",
    sku: "HW-002",
    quantity: "3",
    minimumStock: "2",
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.sku, /unique/);
});

test("updateItem and deleteItem report missing IDs without changing input", () => {
  const original = structuredClone(baseItems);
  assert.deepEqual(updateItem(baseItems, "missing", {
    name: "Any",
    sku: "ANY-1",
    quantity: 1,
    minimumStock: 0,
  }), {
    ok: false,
    reason: "not-found",
  });
  assert.deepEqual(deleteItem(baseItems, "missing"), {
    ok: false,
    reason: "not-found",
  });
  assert.deepEqual(baseItems, original);
});

test("deleteItem removes only the requested item without mutating input", () => {
  const original = structuredClone(baseItems);
  const result = deleteItem(baseItems, "2");

  assert.equal(result.ok, true);
  assert.deepEqual(result.item, baseItems[1]);
  assert.deepEqual(result.items.map((item) => item.id), ["1", "3"]);
  assert.deepEqual(baseItems, original);
  assert.notStrictEqual(result.items, baseItems);
});

test("searchItems matches partial names and SKUs case-insensitively", () => {
  assert.deepEqual(searchItems(baseItems, " GLOVES ").map((item) => item.id), ["3"]);
  assert.deepEqual(searchItems(baseItems, "hw-00").map((item) => item.id), ["1"]);
  assert.deepEqual(searchItems(baseItems, "missing"), []);
});

test("searchItems returns a new array when the query is blank", () => {
  const result = searchItems(baseItems, "   ");
  assert.deepEqual(result, baseItems);
  assert.notStrictEqual(result, baseItems);
});

test("sortItems supports every key in both directions", () => {
  const expectedAscending = {
    name: ["2", "3", "1"],
    sku: ["1", "2", "3"],
    quantity: ["2", "1", "3"],
    minimumStock: ["2", "3", "1"],
  };

  for (const [key, ids] of Object.entries(expectedAscending)) {
    assert.deepEqual(sortItems(baseItems, key, "asc").map((item) => item.id), ids);
    assert.deepEqual(
      sortItems(baseItems, key, "desc").map((item) => item.id),
      [...ids].reverse(),
    );
  }
});

test("sortItems uses deterministic name, SKU, and ID tie-breakers", () => {
  const tied = [
    { id: "b", name: "Same", sku: "B", quantity: 1, minimumStock: 1 },
    { id: "a", name: "same", sku: "A", quantity: 1, minimumStock: 1 },
    { id: "c", name: "Same", sku: "A", quantity: 1, minimumStock: 1 },
  ];

  assert.deepEqual(
    sortItems(tied, "quantity", "desc").map((item) => item.id),
    ["a", "c", "b"],
  );
});

test("sortItems returns a new array and rejects invalid options", () => {
  const result = sortItems(baseItems, "name", "asc");
  assert.notStrictEqual(result, baseItems);
  assert.throws(() => sortItems(baseItems, "id", "asc"), RangeError);
  assert.throws(() => sortItems(baseItems, "name", "sideways"), RangeError);
});

test("low stock uses the quantity-equals-minimum boundary", () => {
  assert.equal(isLowStock({ quantity: 3, minimumStock: 3 }), true);
  assert.equal(isLowStock({ quantity: 4, minimumStock: 3 }), false);
  assert.equal(countLowStock(baseItems), 1);
  assert.equal(countLowStock([...baseItems, { quantity: 3, minimumStock: 3 }]), 2);
});

test("storage constants expose a versioned key and schema version", () => {
  assert.equal(STORAGE_KEY, "inventory-tool.inventory.v1");
  assert.equal(STORAGE_VERSION, 1);
});

test("stored inventory round-trips with versioned data", () => {
  const serialized = serializeStoredInventory(baseItems);
  const parsedPayload = JSON.parse(serialized);

  assert.equal(parsedPayload.version, 1);
  assert.deepEqual(parsedPayload.items, baseItems);

  const result = parseStoredInventory(serialized);
  assert.deepEqual(result, { ok: true, items: baseItems });
});

test("stored inventory parsing rejects malformed, wrong-version, and invalid data", () => {
  const malformed = parseStoredInventory("{not json");
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /malformed JSON/);

  const wrongVersion = parseStoredInventory(JSON.stringify({ version: 99, items: [] }));
  assert.equal(wrongVersion.ok, false);
  assert.match(wrongVersion.error, /unsupported version/);

  const duplicateSku = parseStoredInventory(JSON.stringify({
    version: 1,
    items: [
      { id: "1", name: "One", sku: "SAME", quantity: 1, minimumStock: 0 },
      { id: "2", name: "Two", sku: "same", quantity: 1, minimumStock: 0 },
    ],
  }));
  assert.equal(duplicateSku.ok, false);
  assert.match(duplicateSku.error, /duplicate SKU/);

  const invalidQuantity = parseStoredInventory(JSON.stringify({
    version: 1,
    items: [{ id: "1", name: "One", sku: "ONE", quantity: -1, minimumStock: 0 }],
  }));
  assert.equal(invalidQuantity.ok, false);
  assert.match(invalidQuantity.error, /invalid quantity/);
});

test("exportInventoryJson contains every item and exactly four public fields", () => {
  const filtered = searchItems(baseItems, "gloves");
  const exportedAll = JSON.parse(exportInventoryJson(baseItems));

  assert.equal(exportedAll.length, 3);
  assert.deepEqual(exportedAll, baseItems.map(({ name, sku, quantity, minimumStock }) => ({
    name,
    sku,
    quantity,
    minimumStock,
  })));
  assert.ok(exportedAll.every((item) => {
    return Object.keys(item).sort().join(",") === "minimumStock,name,quantity,sku";
  }));

  assert.deepEqual(JSON.parse(exportInventoryJson(filtered)), [{
    name: "Canvas gloves",
    sku: "SF-004",
    quantity: 12,
    minimumStock: 3,
  }]);
});
