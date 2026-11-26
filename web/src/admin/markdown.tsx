import type { ReactNode } from "react";

/*
 * Just enough Markdown for the agent guide (`server/agent-guide.md`): headings, paragraphs, lists,
 * fenced code, tables, and inline code, bold and links. Built as React elements, never as HTML,
 * so nothing in the text can run.
 */

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    const [, code, bold, label, href = ""] = match;
    const key = parts.length;
    if (code !== undefined) parts.push(<code key={key}>{code}</code>);
    else if (bold !== undefined) parts.push(<strong key={key}>{bold}</strong>);
    else if (/^(?:https?:\/\/|\/)/.test(href))
      parts.push(
        <a key={key} href={href}>
          {label}
        </a>,
      );
    else parts.push(label);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "list"; start: number | null; items: string[] }
  | { kind: "paragraph"; text: string };

const ITEM = /^(-|\d+\.)\s+/;
const FENCE = /^\s*```/;
const BLOCK_START = /^(?:#|\||```|-\s|\d+\.\s)/;

class Lines {
  index = 0;
  constructor(readonly lines: readonly string[]) {}
  get line(): string {
    return this.lines[this.index] ?? "";
  }
  get done(): boolean {
    return this.index >= this.lines.length;
  }
  /** Consecutive lines that pass `test`. */
  take(test: (line: string) => boolean): string[] {
    const taken: string[] = [];
    while (!this.done && test(this.line)) taken.push(this.lines[this.index++] ?? "");
    return taken;
  }
}

function code(lines: Lines): Block {
  const indent = lines.line.indexOf("`");
  lines.index += 1;
  const text = lines.take((line) => !FENCE.test(line));
  lines.index += 1;
  return { kind: "code", text: text.map((line) => line.slice(indent)).join("\n") };
}

/** A list; an item's indented lines continue it, an indented code block ends it. */
function list(lines: Lines): Block {
  const first = ITEM.exec(lines.line)?.[1] ?? "-";
  const items: string[] = [];
  while (!lines.done) {
    const line = lines.line;
    const blankBeforeIndented =
      line.trim() === "" && /^\s+\S/.test(lines.lines[lines.index + 1] ?? "");
    if (ITEM.test(line)) items.push(line.replace(ITEM, ""));
    else if (/^\s+\S/.test(line) && !FENCE.test(line))
      items.push(`${items.pop() ?? ""} ${line.trim()}`);
    else if (!blankBeforeIndented) break;
    lines.index += 1;
    if (FENCE.test(lines.line)) break;
  }
  return { kind: "list", start: first === "-" ? null : Number.parseInt(first, 10), items };
}

/** Splits the text into blocks. */
export function blocks(markdown: string): Block[] {
  const lines = new Lines(markdown.split("\n"));
  const out: Block[] = [];
  while (!lines.done) {
    const line = lines.line;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      lines.index += 1;
    } else if (heading !== null) {
      out.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      lines.index += 1;
    } else if (FENCE.test(line)) {
      out.push(code(lines));
    } else if (line.startsWith("|")) {
      const rows = lines.take((next) => next.startsWith("|"));
      out.push({ kind: "table", rows: rows.filter((row) => !/^[\s|:-]+$/.test(row)).map(cells) });
    } else if (ITEM.test(line)) {
      out.push(list(lines));
    } else {
      const text = lines.take((next) => next.trim() !== "" && !BLOCK_START.test(next.trimStart()));
      out.push({ kind: "paragraph", text: text.join(" ") });
    }
  }
  return out;
}

function Table({ rows }: { readonly rows: readonly string[][] }): ReactNode {
  const [head = [], ...body] = rows;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {head.map((cell, column) => (
              <th key={column} scope="col">
                {inline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, at) => (
            <tr key={at}>
              {row.map((cell, column) => (
                <td key={column}>{inline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return <Tag key={key}>{inline(block.text)}</Tag>;
    }
    case "code":
      return (
        <pre key={key} className="guide-code">
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return <Table key={key} rows={block.rows} />;
    case "list": {
      const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>);
      return block.start === null ? (
        <ul key={key}>{items}</ul>
      ) : (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      );
    }
    case "paragraph":
      return <p key={key}>{inline(block.text)}</p>;
  }
}

export function Markdown({ text }: { readonly text: string }): ReactNode {
  return <div className="guide">{blocks(text).map(renderBlock)}</div>;
}
