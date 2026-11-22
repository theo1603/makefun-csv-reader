// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for {text, header}, following the same written broken-row
// policy. Written from the policy (RULES.txt), not copied from the reference.
//
// Speed comes from scanning with native primitives instead of one character at a
// time: unquoted fields are sliced between the next comma / LF / CR found by one
// regex, quoted fields are sliced between the opening quote and the closing quote
// found by indexOf, and only the rare broken bits (stray CRs, doubled quotes,
// line breaks inside quotes) take a slower path.

/** The next field terminator outside quotes: comma, CR or LF. */
const SPECIAL = /[,\r\n]/g;
/** One line break inside quotes: CRLF, lone CR or LF. */
const BREAKS = /\r\n?|\n/g;
/** A doubled quote inside a quoted field. */
const DOUBLED = /""/g;

/** How a field ended: 0 comma (record goes on), 1 line break, 2 end of text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns [value, ended, added], where
  // `added` counts the characters kept (the initial value is not counted).
  function readUnquoted(init) {
    let parts = null; // slices joined only when a stray CR splits the field
    let added = 0;
    let start = pos;
    for (;;) {
      SPECIAL.lastIndex = pos;
      const m = SPECIAL.exec(text);
      if (m === null) {
        const seg = text.slice(start);
        added += seg.length;
        pos = len;
        return [parts === null ? (init === '' ? seg : init + seg) : parts.join('') + seg, END, added];
      }
      const idx = m.index;
      const c = text.charCodeAt(idx);
      if (c === 44) {
        const seg = text.slice(start, idx);
        added += seg.length;
        pos = idx + 1;
        return [parts === null ? (init === '' ? seg : init + seg) : parts.join('') + seg, COMMA, added];
      }
      if (c === 10) {
        const seg = text.slice(start, idx);
        added += seg.length;
        pos = idx + 1;
        line += 1;
        return [parts === null ? (init === '' ? seg : init + seg) : parts.join('') + seg, LINE_BREAK, added];
      }
      if (text.charCodeAt(idx + 1) === 10) {
        const seg = text.slice(start, idx);
        added += seg.length;
        pos = idx + 2;
        line += 1;
        return [parts === null ? (init === '' ? seg : init + seg) : parts.join('') + seg, LINE_BREAK, added];
      }
      // A CR not followed by LF is dropped (stray_cr); the field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const seg = text.slice(start, idx);
      added += seg.length;
      if (parts === null) parts = [init, seg];
      else parts.push(seg);
      pos = idx + 1;
      start = idx + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns [value, ended, added]
  // like readUnquoted (added is only meaningful on the junk path).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let scan = open + 1;
    let hasDoubled = false;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        hasDoubled = true;
        scan = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after it is
      // read again as an unquoted field (unterminated_quote).
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      line = openLine;
      return readUnquoted('"');
    }
    let content = text.slice(open + 1, close);
    if (hasDoubled) content = content.replace(DOUBLED, '"');
    const breaks = content.match(BREAKS);
    if (breaks !== null) {
      // Each CRLF or lone CR inside quotes is read as one LF, and counts a line.
      line += breaks.length;
      content = content.replace(BREAKS, '\n');
    }
    pos = close + 1;
    if (pos >= len) return [content, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [content, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [content, LINE_BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [content, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the next comma
    // or line break (quote_junk, when the field ends with anything appended).
    const junk = readUnquoted(content);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
    } while (field[1] === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
