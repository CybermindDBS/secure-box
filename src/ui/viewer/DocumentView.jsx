import { useState } from 'react';
import { colName } from '../../core/readers.js';

/** Renders the document model from core/readers.js: text only, never markup from the file. */
function Runs({ runs }) {
  return runs.map((run, i) => {
    if (run.image) {
      // eslint-disable-next-line react/no-array-index-key
      return <span key={i} className="doc-image">image</span>;
    }
    let node = run.text.includes('\n')
      ? run.text.split('\n').flatMap((part, j) => (j ? [<br key={`b${j}`} />, part] : [part]))
      : run.text;
    if (run.code) node = <code>{node}</code>;
    if (run.b) node = <strong>{node}</strong>;
    if (run.i) node = <em>{node}</em>;
    if (run.u) node = <u>{node}</u>;
    if (run.s) node = <s>{node}</s>;
    if (run.href && /^https?:\/\//i.test(run.href)) {
      node = (
        <a href={run.href} target="_blank" rel="noopener noreferrer">
          {node}
        </a>
      );
    }
    // eslint-disable-next-line react/no-array-index-key
    return <span key={i}>{node}</span>;
  });
}

function Table({ rows, header = false, numbered = false }) {
  const width = Math.max(0, ...rows.map((r) => (r ? r.length : 0)));
  const cols = Array.from({ length: width }, (_, c) => c);
  return (
    <div className="doc-table-wrap">
      <table className={`doc-table${numbered ? ' doc-grid' : ''}`}>
        {numbered ? (
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, r) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={r}>
              {numbered ? <th className="doc-rownum">{r + 1}</th> : null}
              {cols.map((c) => {
                const Cell = header && r === 0 ? 'th' : 'td';
                return <Cell key={c}>{(row && row[c]) ?? ''}</Cell>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }) {
  switch (block.type) {
    case 'h': {
      const H = `h${block.level}`;
      return (
        <H>
          <Runs runs={block.runs} />
        </H>
      );
    }
    case 'list': {
      const L = block.ordered ? 'ol' : 'ul';
      return (
        <L>
          {block.items.map((item, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i}>
              {item.task ? <input type="checkbox" disabled checked={item.checked} /> : null}
              {item.task ? ' ' : null}
              <Runs runs={item.runs} />
            </li>
          ))}
        </L>
      );
    }
    case 'table':
      return <Table rows={block.rows} header={block.header} />;
    case 'pre':
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote>
          <Runs runs={block.runs} />
        </blockquote>
      );
    case 'hr':
      return <hr />;
    default:
      return (
        <p>
          <Runs runs={block.runs} />
        </p>
      );
  }
}

function Sheets({ doc }) {
  const [index, setIndex] = useState(0);
  if (!doc.sheets.length) return <p className="doc-empty">This spreadsheet is empty.</p>;
  const sheet = doc.sheets[Math.min(index, doc.sheets.length - 1)];
  return (
    <div className="doc-sheets">
      <div className="sheet-stage">
        <Table rows={sheet.rows} numbered />
        {sheet.truncated ? <p className="doc-note">Showing the first {doc.maxRows} rows and {doc.maxCols} columns.</p> : null}
      </div>
      {doc.sheets.length > 1 ? (
        <div className="sheet-tabs" role="tablist">
          {doc.sheets.map((s, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <button key={i} type="button" role="tab" className="sheet-tab" aria-selected={i === index} onClick={() => setIndex(i)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DocumentView({ doc, mono }) {
  switch (doc.type) {
    case 'page':
      return (
        <article className={`doc-page${doc.markdown ? ' doc-markdown' : ''}`}>
          {doc.blocks.length ? doc.blocks.map((block, i) => <Block key={i} block={block} />) : <p className="muted">This document has no text.</p>}
        </article>
      );
    case 'sheets':
      return <Sheets doc={doc} />;
    case 'slides':
      return doc.slides.length ? (
        <div className="doc-slides">
          {doc.slides.map((slide, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <section key={i} className="doc-slide">
              <span className="doc-slide-num">Slide {i + 1}</span>
              {slide.title ? <h2>{slide.title}</h2> : null}
              {slide.lines.length ? (
                <ul>
                  {slide.lines.map((line, j) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <p className="doc-empty">This presentation has no slides.</p>
      );
    case 'table':
      return (
        <div className="doc-sheets">
          <Table rows={doc.rows} header />
          {doc.note ? <p className="doc-note">{doc.note}</p> : null}
        </div>
      );
    case 'plain':
      return (
        <article className={`doc-page doc-plain${mono ? ' is-mono' : ''}`}>
          {doc.text.trim() ? <div className="doc-plain-text">{doc.text}</div> : <p className="muted">This file is empty.</p>}
          {doc.note ? <p className="doc-note">{doc.note}</p> : null}
        </article>
      );
    default:
      return <pre className={`doc-text${doc.prose ? ' doc-text-prose' : ''}`}>{doc.text}</pre>;
  }
}
