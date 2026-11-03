export const STORAGE_KEY = "inventory-tool.inventory.v1";
export const STORAGE_VERSION = 1;
export const SORT_KEYS = ["name", "sku", "quantity", "minimumStock"];

const SORT_DIRECTIONS = ["asc", "desc"];
const INTEGER_PATTERN = /^\d+$/;
const STORED_ITEM_FIELDS = ["id", "name", "sku", "quantity", "minimumStock"];

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseNonnegativeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasExactKeys(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareItems(left, right) {
  const leftName = normalizeText(left.name);
  const rightName = normalizeText(right.name);
  return (
    compareText(leftName, rightName) ||
    compareText(normalizeText(left.sku), normalizeText(right.sku)) ||
    compareText(left.id, right.id)
  );
}

function toStoredItem(item) {
  return {
    id: item.id,
    name: item.name,
    sku: item.sku,
    quantity: item.quantity,
    minimumStock: item.minimumStock,
  };
}

export function validateItemInput(input, items = [], ignoreId = null) {
  const errors = {};
  const value = {
    name: typeof input?.name === "string" ? input.name.trim() : "",
    sku: typeof input?.sku === "string" ? input.sku.trim() : "",
    quantity: parseNonnegativeInteger(input?.quantity),
    minimumStock: parseNonnegativeInteger(input?.minimumStock),
  };

  if (!value.name) {
    errors.name = "Name is required.";
  }

  if (!value.sku) {
    errors.sku = "SKU is required.";
  } else {
    const duplicate = items.some(
      (item) => item.id !== ignoreId && normalizeText(item.sku) === normalizeText(value.sku),
    );
    if (duplicate) {
      errors.sku = "SKU must be unique.";
    }
  }

  if (value.quantity === null) {
    errors.quantity = "Quantity must be a nonnegative integer.";
  }

  if (value.minimumStock === null) {
    errors.minimumStock = "Minimum stock must be a nonnegative integer.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value };
}

export function addItem(items, input, id) {
  const validation = validateItemInput(input, items);
  if (!validation.ok) {
    return validation;
  }

  if (typeof id !== "string" || !id.trim()) {
    return { ok: false, errors: { id: "A nonempty item ID is required." } };
  }

  if (items.some((item) => item.id === id)) {
    return { ok: false, errors: { id: "Item ID must be unique." } };
  }

  const item = { id, ...validation.value };
  return { ok: true, item, items: [...items, item] };
}

export function updateItem(items, id, input) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    return { ok: false, reason: "not-found" };
  }

  const validation = validateItemInput(input, items, id);
  if (!validation.ok) {
    return validation;
  }

  const item = { id, ...validation.value };
  const nextItems = items.map((current, currentIndex) => (currentIndex === index ? item : current));
  return { ok: true, item, items: nextItems };
}

export function deleteItem(items, id) {
  const item = items.find((current) => current.id === id);
  if (!item) {
    return { ok: false, reason: "not-found" };
  }

  return {
    ok: true,
    item,
    items: items.filter((current) => current.id !== id),
  };
}

export function searchItems(items, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [...items];
  }

  return items.filter(
    (item) =>
      normalizeText(item.name).includes(normalizedQuery) ||
      normalizeText(item.sku).includes(normalizedQuery),
  );
}

export function sortItems(items, key, direction = "asc") {
  if (!SORT_KEYS.includes(key)) {
    throw new RangeError(`Unsupported sort key: ${key}`);
  }
  if (!SORT_DIRECTIONS.includes(direction)) {
    throw new RangeError(`Unsupported sort direction: ${direction}`);
  }

  const multiplier = direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    let comparison;
    if (key === "quantity" || key === "minimumStock") {
      comparison = left[key] - right[key];
    } else {
      comparison = compareText(normalizeText(left[key]), normalizeText(right[key]));
    }

    return comparison * multiplier || compareItems(left, right);
  });
}

export function isLowStock(item) {
  return item.quantity <= item.minimumStock;
}

export function countLowStock(items) {
  return items.reduce((count, item) => count + (isLowStock(item) ? 1 : 0), 0);
}

export function parseStoredInventory(raw) {
  if (typeof raw !== "string") {
    return { ok: false, error: "Stored inventory must be a JSON string." };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Stored inventory contains malformed JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Stored inventory must be an object." };
  }

  if (parsed.version !== STORAGE_VERSION) {
    return { ok: false, error: "Stored inventory has an unsupported version." };
  }

  if (!Array.isArray(parsed.items)) {
    return { ok: false, error: "Stored inventory items must be an array." };
  }

  const ids = new Set();
  const skus = new Set();

  for (const [index, item] of parsed.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `Stored item ${index} must be an object.` };
    }

    if (!hasExactKeys(item, STORED_ITEM_FIELDS)) {
      return { ok: false, error: `Stored item ${index} has invalid fields.` };
    }

    if (typeof item.id !== "string" || !item.id.trim()) {
      return { ok: false, error: `Stored item ${index} has an invalid ID.` };
    }
    if (ids.has(item.id)) {
      return { ok: false, error: `Stored item ${index} has a duplicate ID.` };
    }

    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name !== item.name.trim()
    ) {
      return { ok: false, error: `Stored item ${index} has an invalid name.` };
    }

    if (
      typeof item.sku !== "string" ||
      !item.sku.trim() ||
      item.sku !== item.sku.trim()
    ) {
      return { ok: false, error: `Stored item ${index} has an invalid SKU.` };
    }

    const normalizedSku = normalizeText(item.sku);
    if (skus.has(normalizedSku)) {
      return { ok: false, error: `Stored item ${index} has a duplicate SKU.` };
    }

    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) {
      return { ok: false, error: `Stored item ${index} has an invalid quantity.` };
    }

    if (!Number.isSafeInteger(item.minimumStock) || item.minimumStock < 0) {
      return { ok: false, error: `Stored item ${index} has an invalid minimum stock.` };
    }

    ids.add(item.id);
    skus.add(normalizedSku);
  }

  return { ok: true, items: parsed.items.map(toStoredItem) };
}

export function serializeStoredInventory(items) {
  return JSON.stringify({
    version: STORAGE_VERSION,
    items: items.map(toStoredItem),
  });
}

export function exportInventoryJson(items) {
  return JSON.stringify(
    items.map(({ name, sku, quantity, minimumStock }) => ({
      name,
      sku,
      quantity,
      minimumStock,
    })),
  );
}
