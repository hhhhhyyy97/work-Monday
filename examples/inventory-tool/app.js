import {
  STORAGE_KEY,
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
} from "./inventory.js";

const form = document.querySelector("#item-form");
const itemIdInput = document.querySelector("#item-id");
const nameInput = document.querySelector("#name");
const skuInput = document.querySelector("#sku");
const quantityInput = document.querySelector("#quantity");
const minimumStockInput = document.querySelector("#minimum-stock");
const formHeading = document.querySelector("#form-heading");
const saveButton = document.querySelector("#save-button");
const cancelButton = document.querySelector("#cancel-button");
const searchInput = document.querySelector("#search");
const sortKeySelect = document.querySelector("#sort-key");
const sortDirectionSelect = document.querySelector("#sort-direction");
const exportButton = document.querySelector("#export-button");
const statusElement = document.querySelector("#status");
const lowStockCount = document.querySelector("#low-stock-count");
const emptyState = document.querySelector("#empty-state");
const tableWrap = document.querySelector("#table-wrap");
const inventoryBody = document.querySelector("#inventory-body");

let items = [];
let editingId = null;
let searchQuery = "";
let sortKey = "name";
let sortDirection = "asc";

function showStatus(message, tone = "success") {
  statusElement.textContent = message;
  statusElement.className = "status";
  if (tone) {
    statusElement.classList.add(`status--${tone}`);
  }
}

function clearStatus() {
  showStatus("", "");
}

function clearValidationErrors() {
  for (const errorElement of document.querySelectorAll("[data-error-for]")) {
    errorElement.textContent = "";
  }
  for (const input of form.querySelectorAll("[aria-invalid]")) {
    input.removeAttribute("aria-invalid");
  }
}

function showValidationErrors(errors) {
  clearValidationErrors();
  for (const [field, message] of Object.entries(errors)) {
    const errorElement = document.querySelector(`[data-error-for="${field}"]`);
    const input = form.elements.namedItem(field);
    if (errorElement) {
      errorElement.textContent = message;
    }
    if (input instanceof HTMLElement) {
      input.setAttribute("aria-invalid", "true");
    }
  }
  showStatus("Check the highlighted fields and try again.", "error");
  const firstInvalidInput = form.querySelector('[aria-invalid="true"]');
  firstInvalidInput?.focus();
}

function readFormInput() {
  return {
    name: nameInput.value,
    sku: skuInput.value,
    quantity: quantityInput.value,
    minimumStock: minimumStockInput.value,
  };
}

function resetForm() {
  editingId = null;
  form.reset();
  itemIdInput.value = "";
  formHeading.textContent = "Add item";
  saveButton.textContent = "Save item";
  cancelButton.hidden = true;
  clearValidationErrors();
}

function enterEditMode(item) {
  editingId = item.id;
  itemIdInput.value = item.id;
  nameInput.value = item.name;
  skuInput.value = item.sku;
  quantityInput.value = String(item.quantity);
  minimumStockInput.value = String(item.minimumStock);
  formHeading.textContent = "Edit item";
  saveButton.textContent = "Update item";
  cancelButton.hidden = false;
  clearValidationErrors();
  clearStatus();
  nameInput.focus();
}

function createCell(content, className = "") {
  const cell = document.createElement("td");
  if (className) {
    cell.className = className;
  }
  cell.textContent = content;
  return cell;
}

function createDeleteButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action row-action--danger";
  button.textContent = "Delete";
  button.setAttribute("aria-label", `Delete ${item.name}, SKU ${item.sku}`);
  button.addEventListener("click", () => {
    const result = deleteItem(items, item.id);
    if (!result.ok) {
      resetForm();
      showStatus("That item no longer exists. The list has been refreshed.", "warning");
      render();
      return;
    }

    items = result.items;
    if (editingId === item.id) {
      resetForm();
    }
    render();
    persistItems(`Deleted ${result.item.name}.`);
  });
  return button;
}

function createEditButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.textContent = "Edit";
  button.setAttribute("aria-label", `Edit ${item.name}, SKU ${item.sku}`);
  button.addEventListener("click", () => enterEditMode(item));
  return button;
}

function renderRow(item) {
  const row = document.createElement("tr");
  if (isLowStock(item)) {
    row.className = "low-stock";
  }

  row.append(
    createCell(item.name),
    createCell(item.sku),
    createCell(String(item.quantity), "numeric"),
    createCell(String(item.minimumStock), "numeric"),
  );

  const statusCell = document.createElement("td");
  if (isLowStock(item)) {
    const badge = document.createElement("span");
    badge.className = "low-stock-badge";
    badge.textContent = "Low stock";
    statusCell.append(badge);
  } else {
    const label = document.createElement("span");
    label.className = "stock-ok";
    label.textContent = "In stock";
    statusCell.append(label);
  }
  row.append(statusCell);

  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(createEditButton(item), createDeleteButton(item));
  actionsCell.append(actions);
  row.append(actionsCell);
  return row;
}

function render() {
  const visibleItems = sortItems(searchItems(items, searchQuery), sortKey, sortDirection);
  inventoryBody.replaceChildren(...visibleItems.map(renderRow));

  const lowCount = countLowStock(items);
  lowStockCount.textContent = `${lowCount} low-stock ${lowCount === 1 ? "item" : "items"}`;

  if (items.length === 0) {
    emptyState.textContent = "No inventory items yet. Add an item to start tracking stock.";
    emptyState.hidden = false;
    tableWrap.hidden = true;
  } else if (visibleItems.length === 0) {
    emptyState.textContent = "No items match the current search.";
    emptyState.hidden = false;
    tableWrap.hidden = true;
  } else {
    emptyState.hidden = true;
    tableWrap.hidden = false;
  }
}

function persistItems(successMessage) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeStoredInventory(items));
    showStatus(successMessage, "success");
    return true;
  } catch (error) {
    console.error("Unable to save inventory.", error);
    showStatus(
      `${successMessage} Browser storage failed, so the change may not survive a reload.`,
      "warning",
    );
    return false;
  }
}

function loadItems() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error("Unable to read inventory storage.", error);
    showStatus(
      "Browser storage is unavailable. You can use the tool, but changes may not persist.",
      "warning",
    );
    return;
  }

  if (raw === null) {
    return;
  }

  const parsed = parseStoredInventory(raw);
  if (!parsed.ok) {
    console.warn("Unable to load saved inventory:", parsed.error);
    showStatus(
      `Saved inventory could not be loaded (${parsed.error}). Starting with an empty inventory.`,
      "warning",
    );
    return;
  }

  items = parsed.items;
}

function createItemId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearStatus();

  const input = readFormInput();
  const result = editingId
    ? updateItem(items, editingId, input)
    : addItem(items, input, createItemId());

  if (!result.ok) {
    if (result.reason === "not-found") {
      resetForm();
      render();
      showStatus("That item no longer exists. The edit was not saved.", "warning");
      return;
    }
    showValidationErrors(result.errors);
    return;
  }

  const action = editingId ? "Updated" : "Added";
  items = result.items;
  resetForm();
  render();
  persistItems(`${action} ${result.item.name}.`);
});

cancelButton.addEventListener("click", () => {
  resetForm();
  clearStatus();
  nameInput.focus();
});

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  render();
});

sortKeySelect.addEventListener("change", () => {
  sortKey = sortKeySelect.value;
  render();
});

sortDirectionSelect.addEventListener("change", () => {
  sortDirection = sortDirectionSelect.value;
  render();
});

exportButton.addEventListener("click", () => {
  let objectUrl;
  try {
    const blob = new Blob([exportInventoryJson(items)], { type: "application/json" });
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "inventory.json";
    document.body.append(link);
    link.click();
    link.remove();
    showStatus(`Exported ${items.length} ${items.length === 1 ? "item" : "items"}.`, "success");
  } catch (error) {
    console.error("Unable to export inventory.", error);
    showStatus("The inventory could not be exported. Please try again.", "error");
  } finally {
    if (objectUrl) {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
});

loadItems();
render();
