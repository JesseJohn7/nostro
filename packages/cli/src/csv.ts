/**
 * RFC 4180 CSV: comma-separated, double quotes around a cell that holds a
 * comma, a quote or a line break, and "" for a quote inside one. Each record
 * carries the physical line it starts on, so errors can name that line.
 */
export interface CsvRecord {
  readonly line: number;
  readonly cells: readonly string[];
}

export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endRecord = () => {
    cells.push(cell);
    cell = "";
    // A blank line is not a record.
    if (!(cells.length === 1 && cells[0] === "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cells.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRecord();
      line++;
      recordLine = line;
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (inQuotes) {
    throw new Error(`line ${recordLine}: a quoted cell is never closed`);
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}
