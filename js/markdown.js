/**
 * markdown.js — Pure Markdown parsing/rendering core for Remnant's
 * live-preview body editor.
 *
 * This module has NO DOM dependency at all — every function here is
 * (text in) -> (classification / HTML string out), nothing more. The
 * contentEditable wiring, cursor tracking, and "which construct is the
 * cursor currently inside" logic all live in app.js; this module doesn't
 * know contentEditable exists. Keeping it pure means the parsing/
 * rendering rules can be fully unit-tested without a browser, and the
 * eventual Export feature can reuse this same module to know what
 * Remnant considers valid Markdown, without dragging in any editor code.
 *
 * ── Scope (this pass): BLOCK-level constructs only ──────────────────
 * Inline emphasis (bold/italic/strikethrough/inline code/links) is a
 * deliberately separate, later pass — see the Markdown Support spec
 * discussion. Supporting it requires sub-line cursor-region tracking
 * that's a meaningfully different problem from "is this whole line a
 * header," so block and inline are built and tested independently
 * rather than risking both at once.
 *
 * Supported block constructs, in priority order (first match wins):
 *   - Fenced code block   ```...``` / ~~~...~~~ (multi-line; see below)
 *   - Header               # through ######
 *   - Horizontal rule       ---, ***, or ___ (a line of 3+ of one char)
 *   - Blockquote            > text
 *   - Unordered list item   - text / * text / + text
 *   - Ordered list item     1. text (any digits, not just "1")
 *   - Plain paragraph line  (no construct recognized — shown as-is)
 *
 * ── The governing rule for ALL of this — read before changing anything ──
 * A line either matches a supported construct's syntax EXACTLY, or it
 * renders as plain literal text. There is no fuzzy matching, no partial
 * credit, no attempt to guess what the user "probably meant." Example:
 * "### Heading ##" (mismatched closing hashes) is not a header — it's
 * shown character-for-character as typed. This is a deliberate product
 * decision (see spec discussion), not a parser limitation: silently
 * correcting or guessing intent would make the editor unpredictable in
 * exactly the moments a user most needs it to be predictable — when
 * something looks wrong on screen and they're trying to fix it.
 *
 * ── Fenced code blocks are the one multi-line construct ─────────────
 * Every other construct here is single-line: a header is one line, a
 * list item is one line (even though several consecutive list items
 * visually form "a list", each item is its own independent renderable
 * unit — see classifyLine). A fenced code block is different: it isn't
 * "done" until its closing fence appears, so it must be identified as a
 * BLOCK of lines together, not line-by-line. segmentIntoBlocks() is what
 * does this grouping; classifyLine() alone would have no way to know
 * "is this fence opening or closing something."
 *
 * ── API ──────────────────────────────────────────────────────────────
 *   Markdown.classifyLine(line)        → { type, render() } — see below
 *   Markdown.segmentIntoBlocks(text)   → Block[] — groups raw text into
 *                                         renderable units; multi-line
 *                                         fenced code blocks are ONE
 *                                         Block, everything else is one
 *                                         Block per line.
 *   Markdown.renderBlock(block)        → HTML string for that block
 *   Markdown.escapeHtml(str)           → HTML-escapes text content so
 *                                         raw Markdown source (which may
 *                                         contain <, >, & etc.) is never
 *                                         interpreted as real HTML when
 *                                         inserted into the DOM.
 *
 * Block shape: { type, raw, lines } where:
 *   - raw is the original, UNMODIFIED source text for this block,
 *     newline-joined if multi-line — this is what gets written back
 *     when the construct reverts to its editable/raw state, so it is
 *     byte-for-byte what the user typed, never a re-serialization.
 *   - lines is the raw text split into its constituent lines (length 1
 *     for every construct except fenced code blocks).
 *   - type is one of: 'code', 'header', 'hr', 'blockquote', 'ul', 'ol',
 *     'paragraph'
 */
const Markdown = (() => {

  // ── HTML escaping ────────────────────────────────────────────────
  // Applied to ALL text content before it's placed in rendered HTML.
  // Markdown source is plain text the user typed — it can freely
  // contain characters like < or & that must never be interpreted as
  // real markup once rendered, or a line like "use <div> tags" would
  // silently vanish or break the page.
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Single-line construct patterns ──────────────────────────────
  // Each regex is anchored to the FULL line (^...$) deliberately — see
  // the governing rule above. Partial/loose matches are not matches.

  const HEADER_RE      = /^(#{1,6})[ \t]+(.+)$/;
  const HR_RE          = /^([-*_])\1{2,}$/; // 3+ of the same one of - * _, nothing else on the line
  const BLOCKQUOTE_RE  = /^>[ \t]?(.*)$/;
  const UL_RE          = /^[-*+][ \t]+(.*)$/;
  const OL_RE          = /^(\d+)\.[ \t]+(.*)$/;
  const FENCE_RE       = /^(```|~~~)(.*)$/; // capture the fence char run and any trailing "language" text

  // classifyLine(line) — single-line classification ONLY. Does not
  // and cannot detect fenced code blocks on its own (that requires
  // knowing whether a matching closing fence exists later in the
  // document) — callers needing fence-awareness must use
  // segmentIntoBlocks() instead, which handles the multi-line case
  // before ever calling this function on the remaining single lines.
  function classifyLine(line) {
    let m;

    if ((m = line.match(HEADER_RE))) {
      return { type: 'header', level: m[1].length, text: m[2] };
    }
    if (HR_RE.test(line)) {
      return { type: 'hr' };
    }
    if ((m = line.match(BLOCKQUOTE_RE))) {
      return { type: 'blockquote', text: m[1] };
    }
    if ((m = line.match(UL_RE))) {
      return { type: 'ul', text: m[1] };
    }
    if ((m = line.match(OL_RE))) {
      return { type: 'ol', number: m[1], text: m[2] };
    }
    return { type: 'paragraph', text: line };
  }

  // ── Block segmentation (handles the one multi-line construct) ──────
  //
  // segmentIntoBlocks(text) walks the document's lines top to bottom.
  // A line matching FENCE_RE opens a code block that consumes every
  // subsequent line verbatim (no classification — code block contents
  // are never interpreted as Markdown themselves, by design: showing
  // literal ```code``` inside a code sample would otherwise be
  // impossible to write) until a line matching FENCE_RE again is found
  // (the closing fence — its own content/language-tag text is ignored,
  // only that it's a fence of the SAME character run length-or-more is
  // required, matching CommonMark's closing-fence rule). If no closing
  // fence ever appears before the document ends, the open fence and
  // everything after it is treated as ONE still-open, unterminated
  // block — per the governing rule, this is shown as a code block that
  // simply hasn't been closed yet (still gets the code styling/raw
  // text), not silently reinterpreted as anything else; the spec's
  // "render only once the closing fence is typed" requirement is about
  // the EDIT/RENDER toggle in app.js, not about this function refusing
  // to recognize an open-but-unterminated fence as code at all.
  function segmentIntoBlocks(text) {
    const lines = (text ?? '').split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const fenceMatch = lines[i].match(FENCE_RE);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1];
        const startIdx = i;
        let j = i + 1;
        let closeIdx = -1;
        while (j < lines.length) {
          const closeMatch = lines[j].match(FENCE_RE);
          if (closeMatch && closeMatch[1][0] === fenceChar[0] && closeMatch[1].length >= fenceChar.length) {
            closeIdx = j;
            break;
          }
          j++;
        }
        const endIdx = closeIdx === -1 ? lines.length - 1 : closeIdx;
        const blockLines = lines.slice(startIdx, endIdx + 1);
        blocks.push({
          type: 'code',
          raw: blockLines.join('\n'),
          lines: blockLines,
          closed: closeIdx !== -1,
        });
        i = endIdx + 1;
        continue;
      }

      // Not a fence — single-line block, classified on its own.
      blocks.push({
        type: classifyLine(lines[i]).type,
        raw: lines[i],
        lines: [lines[i]],
        closed: true, // single-line constructs have no notion of "unterminated"
      });
      i++;
    }

    return blocks;
  }

  // ── Rendering ────────────────────────────────────────────────────
  //
  // renderBlock(block) — HTML string for one Block (from
  // segmentIntoBlocks). Inline emphasis within the text is NOT
  // processed yet (see file header "Scope" note) — block.text/content
  // is escaped and inserted as-is. data-raw carries the block's exact
  // original source, base64-encoded (to survive HTML attribute escaping
  // unscathed regardless of what characters the raw text contains, and
  // to keep multi-line code-block content — which legitimately contains
  // newlines — viable as a single HTML attribute value), so the
  // edit-mode toggle in app.js can restore precisely what was typed
  // without re-deriving or guessing it from the rendered HTML.
  function encodeRaw(raw) {
    // btoa requires a binary string; encodeURIComponent/unescape is the
    // standard two-step trick for round-tripping arbitrary UTF-8 text
    // (titles/content can contain non-Latin1 characters) through btoa,
    // which natively only handles Latin1 byte values.
    return btoa(unescape(encodeURIComponent(raw)));
  }

  function renderBlock(block) {
    const dataRaw = `data-raw="${encodeRaw(block.raw)}"`;

    if (block.type === 'code') {
      // Render the fence lines themselves as part of the visible code
      // text too — a code block's whole raison d'être is showing
      // exactly what was typed, fences included, so stripping them on
      // render and re-adding them on edit would be exactly the kind of
      // "re-serialization" the raw-text-fidelity rule above forbids.
      const inner = escapeHtml(block.raw);
      return `<pre class="md-block md-code" ${dataRaw}><code>${inner}</code></pre>`;
    }

    // Every other block type is single-line; reuse classifyLine on
    // block.lines[0] rather than duplicating the regex matching here.
    const c = classifyLine(block.lines[0]);

    switch (c.type) {
      case 'header':
        return `<h${c.level} class="md-block md-header" ${dataRaw}>${escapeHtml(c.text)}</h${c.level}>`;
      case 'hr':
        return `<hr class="md-block md-hr" ${dataRaw} />`;
      case 'blockquote':
        return `<blockquote class="md-block md-blockquote" ${dataRaw}>${escapeHtml(c.text)}</blockquote>`;
      case 'ul':
        return `<div class="md-block md-list-item md-ul" ${dataRaw}><span class="md-bullet">•</span>${escapeHtml(c.text)}</div>`;
      case 'ol':
        return `<div class="md-block md-list-item md-ol" ${dataRaw}><span class="md-bullet">${escapeHtml(c.number)}.</span>${escapeHtml(c.text)}</div>`;
      case 'paragraph':
      default:
        // Empty lines render as a blank paragraph block (preserves
        // blank-line spacing in the document) rather than collapsing
        // away, since collapsing would silently change the raw text's
        // line count on render — a violation of the round-trip-fidelity
        // rule even though it might look harmless for a single blank line.
        return `<div class="md-block md-paragraph" ${dataRaw}>${escapeHtml(c.text)}</div>`;
    }
  }

  return {
    classifyLine,
    segmentIntoBlocks,
    renderBlock,
    escapeHtml,
  };
})();
