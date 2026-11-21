// Fast drop-in for make.fun's csv-reader 1.0.0 (csv-reader-speed-01-run-20261121).
//
// Returns exactly what csv-reader 1.0.0 returns for {text, header}: {columns, rows, errors}.
// Policy (mirrored from the reference, see README): BOM dropped at the very start; a record
// ends at LF or CRLF and a line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field opening with a quote runs to the next quote that
// is not doubled ("" inside is one quote, CRLF/lone CR inside read as LF); what follows its
// closing quote up to the next comma or line break is appended as it stands (quote_junk when the
// field ends); a quote that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote); a quote inside an unquoted field is literal; fields
// stay strings, never trimmed or converted; rows are padded (short_row, with fields: its count)
// or cut (long_row, with extra: the cut fields) to the first record's width; each error is
// {code, line, row}, line the 1-based line its record starts on, row its index in rows
// (null for the header), in the order met.
//
// Speed: the reference reads one character at a time and builds every field a character at a
// time. This reader instead jumps: an unquoted field is one regex step to its next terminator
// and one slice, a quoted field is one indexOf to its closing quote and one slice per segment,
// with line breaks inside quotes counted and normalised by a single regex pass. No per-character
// loop anywhere on the hot path.

/** Next terminator of an unquoted field: comma, CR or LF. */
const SEP = /[,\r\n]/g;
/** Line breaks inside a quoted field: CRLF and lone CR each become one LF. */
const LB = /\r\n?|\n/g;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Scratch result of readUnquoted, reused so the hot path allocates nothing per field.
  const uq = { value: '', ended: END, added: 0 };

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns uq {value, ended, added}; `added` counts
  // the characters kept, so a caller can tell junk from nothing.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
        }
        pos = len;
        uq.value = value;
        uq.ended = END;
        uq.added = added;
        return uq;
      }
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 44) {
        // Comma: the record goes on.
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        uq.value = value;
        uq.ended = COMMA;
        uq.added = added;
        return uq;
      }
      if (c === 10) {
        // LF: the record ends.
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        line += 1;
        uq.value = value;
        uq.ended = LINE_BREAK;
        uq.added = added;
        return uq;
      }
      // CR.
      if (text.charCodeAt(i + 1) === 10) {
        // CRLF: the record ends.
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 2;
        line += 1;
        uq.value = value;
        uq.ended = LINE_BREAK;
        uq.added = added;
        return uq;
      }
      // Lone CR: dropped (stray_cr), reading goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(pos, i);
      added += i - pos;
      pos = i + 1;
    }
  }

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
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
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      if (quoted) {
        // A field that opens with a quote runs to the next quote that is not doubled.
        const open = pos;
        const openLine = line;
        value = '';
        pos += 1;
        let closed = false;
        while (pos < len) {
          const q = text.indexOf('"', pos);
          if (q === -1) break;
          // The segment pos..q holds no quote; normalise its line breaks (CRLF and lone CR
          // each one LF) and count them, then append it.
          if (q > pos) {
            const seg = text.slice(pos, q);
            if (seg.indexOf('\r') !== -1) {
              let n = 0;
              value += seg.replace(LB, () => {
                n += 1;
                return '\n';
              });
              line += n;
            } else {
              value += seg;
              let n = 0;
              let j = seg.indexOf('\n');
              while (j !== -1) {
                n += 1;
                j = seg.indexOf('\n', j + 1);
              }
              line += n;
            }
          }
          if (text.charCodeAt(q + 1) === 34) {
            // Doubled quote: one quote, and the field goes on.
            value += '"';
            pos = q + 2;
            continue;
          }
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it is
          // read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquoted('"');
          value = r.value;
          ended = r.ended;
        } else if (pos >= len) {
          ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            ended = COMMA;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands, up to the next
            // comma or line break.
            const r = readUnquoted(value);
            if (r.added > 0) {
              errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
            value = r.value;
            ended = r.ended;
          }
        }
      } else {
        const r = readUnquoted('');
        value = r.value;
        ended = r.ended;
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
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
