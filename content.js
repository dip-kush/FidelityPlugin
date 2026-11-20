chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EXTRACT_FIDELITY_POSITIONS") return false;

  try {
    const snapshot = buildSnapshot();
    sendResponse({ ok: true, snapshot });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }

  return true;
});

function buildSnapshot() {
  const now = new Date();
  const extracted = extractPositions();

  return {
    source: "fidelity",
    capturedAt: now.toISOString(),
    capturedDate: now.toISOString().slice(0, 10),
    pageTitle: document.title,
    pageUrl: `${location.origin}${location.pathname}`,
    extraction: extracted.metadata,
    positions: extracted.positions
  };
}

function extractPositions() {
  const agGridRows = extractFidelityAgGridRows();
  if (agGridRows.positions.length > 0) {
    return agGridRows;
  }

  const tableRows = extractTableRows();
  if (tableRows.length > 0) {
    return {
      metadata: { parser: "html-table", visibleColumns: [], missingExpectedFields: [] },
      positions: tableRows.map(normalizeRow).filter(Boolean)
    };
  }

  return {
    metadata: { parser: "loose-dom", visibleColumns: [], missingExpectedFields: [] },
    positions: extractCardLikeRows().map(normalizeLooseText).filter(Boolean)
  };
}

function extractFidelityAgGridRows() {
  const groupedRows = new Map();
  const visibleColumns = new Set();

  document.querySelectorAll(".ag-row.posweb-row-position[row-index]").forEach((row) => {
    const rowIndex = row.getAttribute("row-index");
    if (!rowIndex) return;

    const existing = groupedRows.get(rowIndex) || { rowIndex, rowId: row.getAttribute("row-id"), fields: {} };
    existing.rawText = cleanText(`${existing.rawText || ""} ${row.innerText}`);
    existing.className = cleanText(`${existing.className || ""} ${row.className}`);

    row.querySelectorAll("[col-id]").forEach((cell) => {
      const colId = cell.getAttribute("col-id");
      if (!colId) return;
      visibleColumns.add(colId);
      existing.fields[colId] = cleanText(cell.innerText);

      if (colId === "sym") {
        existing.symbol = cleanText(cell.querySelector(".posweb-cell-symbol-name_container span")?.innerText);
        existing.description = cleanText(cell.querySelector(".posweb-cell-symbol-description")?.innerText);
        existing.symbolTitle = cleanText(cell.querySelector(".posweb-cell-symbol-name_description")?.getAttribute("title"));
      }
    });

    groupedRows.set(rowIndex, existing);
  });

  const positions = Array.from(groupedRows.values())
    .sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex))
    .map(normalizeFidelityAgGridRow)
    .filter(Boolean);

  return {
    metadata: {
      parser: "fidelity-ag-grid",
      visibleColumns: Array.from(visibleColumns),
      missingExpectedFields: missingFidelityFields(visibleColumns)
    },
    positions
  };
}

function normalizeFidelityAgGridRow(row) {
  const symbol = row.symbol || findTicker(row.fields.sym || row.rawText);
  if (!symbol) return null;

  const description = row.description || row.symbolTitle;
  const option = parseFidelityOption(symbol, description) || parseOption(`${symbol} ${description}`);
  const type = option ? "option" : symbol.toLowerCase() === "cash" ? "cash" : "stock";

  return compactObject({
    type,
    symbol: option?.contract || symbol,
    description,
    underlying: option?.underlying,
    expiration: option?.expiration,
    strike: option?.strike,
    optionType: option?.optionType,
    quantity: parseNumber(row.fields.qty),
    lastPrice: parseMoney(row.fields.lstPrc),
    lastPriceChange: parseMoney(row.fields.lstPrChg),
    todayGainLoss: parseMoney(row.fields.todGL),
    todayGainLossPercent: parsePercent(row.fields.todGLPct),
    totalGainLoss: parseMoney(row.fields.totGL),
    totalGainLossPercent: parsePercent(row.fields.totGLPct),
    marketValue: parseMoney(row.fields.curVal),
    costBasisPerShare: parseMoney(row.fields.cstBasShr),
    costBasis: parseMoney(row.fields.cstBasTot),
    fiftyTwoWeekLow: parseFiftyTwoWeekRange(row.fields.fifTwo).low,
    fiftyTwoWeekHigh: parseFiftyTwoWeekRange(row.fields.fifTwo).high,
    accountPercent: parsePercent(row.fields.actPer),
    rowIndex: Number(row.rowIndex),
    rowId: row.rowId,
    raw: compactObject(row.fields)
  });
}

function parseFidelityOption(symbol, description) {
  const match = symbol.match(/^([A-Z][A-Z0-9.]{0,5})\s+\$?([0-9,]+(?:\.[0-9]+)?)\s+(CALL|PUT)$/i);
  if (!match || !description) return null;

  const [, underlying, strikeText, typeText] = match;
  const expiration = normalizeDate(description);
  if (!expiration) return null;

  const strike = parseNumber(strikeText);
  const optionType = normalizeOptionType(typeText);

  return {
    underlying,
    expiration,
    strike,
    optionType,
    contract: `${underlying} ${expiration} ${strike} ${optionType}`
  };
}

function missingFidelityFields(visibleColumns) {
  const expected = new Map([
    ["qty", "quantity"],
    ["cstBasShr", "cost basis per share"],
    ["cstBasTot", "cost basis total"]
  ]);

  return Array.from(expected.entries())
    .filter(([colId]) => !visibleColumns.has(colId))
    .map(([, label]) => label);
}

function extractTableRows() {
  const rows = [];

  document.querySelectorAll("table").forEach((table) => {
    const headers = Array.from(table.querySelectorAll("thead th, thead td"))
      .map((cell) => cleanText(cell.innerText))
      .filter(Boolean);

    table.querySelectorAll("tbody tr, tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td"));
      if (cells.length < 2) return;

      const values = cells.map((cell) => cleanText(cell.innerText));
      if (values.every((value) => !value)) return;

      const fields = {};
      values.forEach((value, index) => {
        const header = headers[index] || `column_${index + 1}`;
        fields[normalizeKey(header)] = value;
      });

      rows.push({
        fields,
        values,
        rawText: cleanText(tr.innerText)
      });
    });
  });

  return uniqueRows(rows);
}

function extractCardLikeRows() {
  const candidates = Array.from(
    document.querySelectorAll("[role='row'], [data-testid*='position' i], [class*='position' i], li, article")
  );

  return uniqueRows(
    candidates
      .map((node) => cleanText(node.innerText))
      .filter((text) => text.length > 20 && looksLikePositionText(text))
      .map((rawText) => ({ rawText }))
  );
}

function normalizeRow(row) {
  const symbol = findField(row.fields, ["symbol", "security", "description"]) || findTicker(row.rawText);
  if (!symbol && !looksLikePositionText(row.rawText)) return null;

  const text = row.rawText;
  const option = parseOption(text);
  const type = option ? "option" : looksLikeStock(symbol, text) ? "stock" : "other";

  return compactObject({
    type,
    symbol: option?.contract || symbol,
    description: findField(row.fields, ["description", "security", "name"]),
    underlying: option?.underlying,
    expiration: option?.expiration,
    strike: option?.strike,
    optionType: option?.optionType,
    quantity: parseNumber(findField(row.fields, ["quantity", "shares", "contracts", "qty"]) || findQuantity(text)),
    lastPrice: parseMoney(findField(row.fields, ["last price", "last", "price"])),
    marketValue: parseMoney(findField(row.fields, ["current value", "market value", "value"])),
    costBasis: parseMoney(findField(row.fields, ["cost basis", "basis"])),
    gainLoss: parseMoney(findField(row.fields, ["gain/loss", "gain loss", "total gain/loss"])),
    rawText: text
  });
}

function normalizeLooseText(row) {
  const text = row.rawText;
  const option = parseOption(text);
  const symbol = option?.contract || findTicker(text);

  if (!symbol && !looksLikePositionText(text)) return null;

  return compactObject({
    type: option ? "option" : "other",
    symbol,
    underlying: option?.underlying,
    expiration: option?.expiration,
    strike: option?.strike,
    optionType: option?.optionType,
    quantity: parseNumber(findQuantity(text)),
    rawText: text
  });
}

function parseOption(text) {
  const normalized = text.replace(/\s+/g, " ");

  const standardMatch = normalized.match(
    /\b([A-Z]{1,6})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\s+\$?([0-9]+(?:\.[0-9]+)?)\s+(CALL|PUT|C|P)\b/i
  );
  if (standardMatch) {
    const [, underlying, expirationText, strikeText, typeText] = standardMatch;
    const optionType = normalizeOptionType(typeText);
    return {
      underlying,
      expiration: normalizeDate(expirationText),
      strike: parseNumber(strikeText),
      optionType,
      contract: `${underlying} ${normalizeDate(expirationText)} ${strikeText} ${optionType}`
    };
  }

  const compactMatch = normalized.match(/\b([A-Z]{1,6})(\d{6})([CP])([0-9]{8})\b/);
  if (compactMatch) {
    const [, underlying, dateText, typeText, strikeText] = compactMatch;
    const expiration = `20${dateText.slice(0, 2)}-${dateText.slice(2, 4)}-${dateText.slice(4, 6)}`;
    const strike = Number(strikeText) / 1000;
    const optionType = normalizeOptionType(typeText);
    return {
      underlying,
      expiration,
      strike,
      optionType,
      contract: `${underlying} ${expiration} ${strike} ${optionType}`
    };
  }

  return null;
}

function findField(fields, labels) {
  const entries = Object.entries(fields);
  for (const label of labels) {
    const key = normalizeKey(label);
    const exact = fields[key];
    if (exact) return exact;

    const fuzzy = entries.find(([entryKey]) => entryKey.includes(key) || key.includes(entryKey));
    if (fuzzy?.[1]) return fuzzy[1];
  }
  return "";
}

function findTicker(text) {
  const match = text.match(/\b[A-Z][A-Z0-9.]{0,5}\b/);
  return match?.[0] || "";
}

function findQuantity(text) {
  const match = text.match(/\b(?:quantity|qty|shares|contracts)\s*:?\s*(-?[0-9,]+(?:\.[0-9]+)?)/i);
  return match?.[1] || "";
}

function looksLikePositionText(text) {
  return /\b(quantity|qty|shares|contracts|market value|cost basis|gain\/loss|last price|call|put)\b/i.test(text);
}

function looksLikeStock(symbol, text) {
  return Boolean(symbol) && !/\b(call|put)\b/i.test(text);
}

function parseMoney(value) {
  if (!value) return null;
  const parsed = parseNumber(String(value).replace(/[+$]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value) {
  if (!value) return null;
  const parsed = parseNumber(String(value).replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFiftyTwoWeekRange(value) {
  const match = String(value || "").match(/Low\s+\$?([0-9,]+(?:\.[0-9]+)?)\s+High\s+\$?([0-9,]+(?:\.[0-9]+)?)/i);
  if (!match) return {};

  return {
    low: parseNumber(match[1]),
    high: parseNumber(match[2])
  };
}

function parseNumber(value) {
  if (!value) return null;
  const negative = /\(|-/.test(String(value));
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function normalizeOptionType(value) {
  return /^c/i.test(value) ? "call" : "put";
}

function normalizeDate(value) {
  const monthMatch = String(value || "").match(/^([A-Za-z]{3})-(\d{1,2})-(\d{4})$/);
  if (monthMatch) {
    const months = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12"
    };
    const [, monthText, day, year] = monthMatch;
    const month = months[monthText.toLowerCase()];
    return month ? `${year}-${month}-${day.padStart(2, "0")}` : "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!String(value || "").includes("/")) return "";

  const [month, day, year] = value.split("/");
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.rawText || JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== "" && value !== null && value !== undefined)
  );
}
