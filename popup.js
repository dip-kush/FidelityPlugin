const SNAPSHOTS_KEY = "fidelityPositionSnapshots";

const els = {
  status: document.querySelector("#status"),
  extractButton: document.querySelector("#extractButton"),
  copyBriefButton: document.querySelector("#copyBriefButton"),
  copyCleanButton: document.querySelector("#copyCleanButton"),
  copyButton: document.querySelector("#copyButton"),
  downloadJsonButton: document.querySelector("#downloadJsonButton"),
  downloadCsvButton: document.querySelector("#downloadCsvButton"),
  stockCount: document.querySelector("#stockCount"),
  optionCount: document.querySelector("#optionCount"),
  otherCount: document.querySelector("#otherCount"),
  snapshotPreview: document.querySelector("#snapshotPreview")
};

let latestSnapshot = null;

init();

function init() {
  els.extractButton.addEventListener("click", extractFromActiveTab);
  els.copyBriefButton.addEventListener("click", copyBriefSnapshot);
  els.copyCleanButton.addEventListener("click", copyCleanSnapshot);
  els.copyButton.addEventListener("click", copyLatestSnapshot);
  els.downloadJsonButton.addEventListener("click", () => downloadLatest("json"));
  els.downloadCsvButton.addEventListener("click", () => downloadLatest("csv"));
  loadLatestSnapshot();
}

async function loadLatestSnapshot() {
  const snapshots = await getSnapshots();
  latestSnapshot = snapshots[0] || null;
  renderSnapshot();
}

async function extractFromActiveTab() {
  setStatus("Reading visible positions...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_FIDELITY_POSITIONS" });
    if (!response?.ok) {
      throw new Error(response?.error || "The page did not return position data.");
    }

    latestSnapshot = response.snapshot;
    await saveSnapshot(latestSnapshot);
    renderSnapshot();
    const missing = latestSnapshot.extraction?.missingExpectedFields || [];
    const missingText = missing.length > 0 ? ` Missing visible fields: ${missing.join(", ")}.` : "";
    setStatus(`Saved ${latestSnapshot.positions.length} positions locally.${missingText}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function copyLatestSnapshot() {
  if (!latestSnapshot) return;

  await navigator.clipboard.writeText(JSON.stringify(latestSnapshot, null, 2));
  setStatus("Copied JSON to clipboard.");
}

async function copyCleanSnapshot() {
  if (!latestSnapshot) return;

  await navigator.clipboard.writeText(JSON.stringify(cleanSnapshot(latestSnapshot), null, 2));
  setStatus("Copied clean JSON to clipboard.");
}

async function copyBriefSnapshot() {
  if (!latestSnapshot) return;

  await navigator.clipboard.writeText(snapshotToBriefCsv(latestSnapshot));
  setStatus("Copied brief CSV to clipboard.");
}

function downloadLatest(format) {
  if (!latestSnapshot) return;

  const isJson = format === "json";
  const text = isJson ? JSON.stringify(latestSnapshot, null, 2) : positionsToCsv(latestSnapshot.positions);
  const type = isJson ? "application/json" : "text/csv";
  const extension = isJson ? "json" : "csv";
  const day = latestSnapshot.capturedDate || new Date().toISOString().slice(0, 10);

  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `fidelity-positions-${day}.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

async function getSnapshots() {
  const stored = await chrome.storage.local.get(SNAPSHOTS_KEY);
  return Array.isArray(stored[SNAPSHOTS_KEY]) ? stored[SNAPSHOTS_KEY] : [];
}

async function saveSnapshot(snapshot) {
  const snapshots = await getSnapshots();
  const withoutToday = snapshots.filter((item) => item.capturedDate !== snapshot.capturedDate);
  const nextSnapshots = [snapshot, ...withoutToday].slice(0, 120);
  await chrome.storage.local.set({ [SNAPSHOTS_KEY]: nextSnapshots });
}

function renderSnapshot() {
  const counts = countPositions(latestSnapshot?.positions || []);
  els.stockCount.textContent = counts.stock;
  els.optionCount.textContent = counts.option;
  els.otherCount.textContent = counts.other;
  els.snapshotPreview.value = latestSnapshot ? JSON.stringify(latestSnapshot, null, 2) : "";

  const hasSnapshot = Boolean(latestSnapshot);
  els.copyBriefButton.disabled = !hasSnapshot;
  els.copyCleanButton.disabled = !hasSnapshot;
  els.copyButton.disabled = !hasSnapshot;
  els.downloadJsonButton.disabled = !hasSnapshot;
  els.downloadCsvButton.disabled = !hasSnapshot;
}

function cleanSnapshot(snapshot) {
  return {
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    capturedDate: snapshot.capturedDate,
    positions: (snapshot.positions || []).map(cleanPosition)
  };
}

function cleanPosition(position) {
  const omitted = new Set(["raw", "rawText", "rowIndex", "rowId"]);
  return Object.fromEntries(
    Object.entries(position).filter(([key, value]) => !omitted.has(key) && value !== undefined && value !== null && value !== "")
  );
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function countPositions(positions) {
  return positions.reduce(
    (counts, position) => {
      if (position.type === "stock") counts.stock += 1;
      else if (position.type === "option") counts.option += 1;
      else counts.other += 1;
      return counts;
    },
    { stock: 0, option: 0, other: 0 }
  );
}

function positionsToCsv(positions) {
  const headers = [
    "type",
    "symbol",
    "description",
    "underlying",
    "expiration",
    "strike",
    "optionType",
    "quantity",
    "lastPrice",
    "lastPriceChange",
    "marketValue",
    "costBasisPerShare",
    "costBasis",
    "gainLoss",
    "todayGainLoss",
    "todayGainLossPercent",
    "totalGainLoss",
    "totalGainLossPercent",
    "fiftyTwoWeekLow",
    "fiftyTwoWeekHigh",
    "accountPercent",
    "rowIndex",
    "rowId",
    "raw",
    "rawText"
  ];
  const rows = positions.map((position) => headers.map((header) => csvCell(position[header])).join(","));
  return [headers.join(","), ...rows].join("\n");
}

function snapshotToBriefCsv(snapshot) {
  const lines = [
    `source,${csvCell(snapshot.source || "")}`,
    `capturedDate,${csvCell(snapshot.capturedDate || "")}`,
    ""
  ];

  const headers = [
    "type",
    "symbol",
    "underlying",
    "qty",
    "holding",
    "last",
    "value",
    "cost",
    "dayGL",
    "totalGL",
    "acctPct",
    "exp",
    "strike",
    "optType"
  ];

  const rows = (snapshot.positions || []).map((position) =>
    [
      position.type,
      position.symbol,
      position.underlying,
      position.quantity,
      positionHolding(position),
      position.lastPrice,
      position.marketValue,
      position.costBasis,
      position.todayGainLoss,
      position.totalGainLoss,
      position.accountPercent,
      position.expiration,
      position.strike,
      position.optionType
    ]
      .map(csvCell)
      .join(",")
  );

  return [...lines, headers.join(","), ...rows].join("\n");
}

function positionHolding(position) {
  if (position.quantity === undefined || position.quantity === null) return "";
  return Number(position.quantity) < 0 ? "sold" : "owned";
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
