/**
 * Email section blocks.
 *
 * Each block takes content and returns email-safe HTML with every brand value
 * already inlined. Nothing here accepts a colour, a font or a size — that is
 * the entire point. A composer offering a colour picker is a composer that
 * will eventually produce an off-brand email; offering only blocks makes
 * off-brand impossible rather than merely discouraged.
 *
 * Tables and inline styles throughout, because Outlook renders through Word:
 * no flexbox, no grid, no <style> block worth relying on, no CSS variables.
 */

import { palette, emailOnly as e, type as t, layout } from './brand.js';

/** Escape anything that reaches the page as text. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** A full-width row. Every block sits in one so spacing stays uniform. */
const row = (inner, { bg = 'transparent', padY = 20 } = {}) => `
<tr>
  <td align="center" bgcolor="${bg}" style="background-color:${bg};padding:${padY}px ${layout.gutter}px;">
    ${inner}
  </td>
</tr>`;

/** Eyebrow — the small tracked caps the brand uses above headings. */
const eyebrow = (text) => !text ? '' : `
<p style="margin:0 0 10px;font-family:${t.bodyStack};font-size:11px;line-height:1.4;
   letter-spacing:${t.trackingEyebrow};text-transform:uppercase;color:${palette.primary};">
  ${esc(text)}</p>`;

export const blocks = {
  /**
   * Hero. Dark, because it is the one place the website's near-black belongs —
   * a band rather than the whole canvas, which keeps the brand recognisable
   * without asking every mail client to render a dark email correctly.
   */
  hero: ({ eyebrow: eb, heading, sub }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td align="center" style="padding:14px 0;">
        ${eyebrow(eb)}
        <h1 style="margin:0;font-family:${t.displayStack};font-size:30px;line-height:1.1;
            text-transform:${t.headingCase};color:${palette.cream};font-weight:400;">
          ${esc(heading)}</h1>
        ${sub ? `<p style="margin:12px 0 0;font-family:${t.bodyStack};font-size:15px;
            line-height:1.55;color:${palette.textOnDark};">${esc(sub)}</p>` : ''}
      </td></tr>
    </table>`, { bg: palette.bg, padY: 28 }),

  /** Body copy. The workhorse — most of any email is this. */
  letter: ({ heading, body }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td>
        ${heading ? `<h2 style="margin:0 0 12px;font-family:${t.displayStack};font-size:21px;
            line-height:1.2;text-transform:${t.headingCase};color:${e.ink};font-weight:400;">
            ${esc(heading)}</h2>` : ''}
        ${String(body ?? '').split(/\n{2,}/).map((p) => `
          <p style="margin:0 0 14px;font-family:${t.bodyStack};font-size:16px;
             line-height:1.65;color:${e.ink};">${esc(p.trim())}</p>`).join('')}
      </td></tr>
    </table>`),

  /** A wine. Image left, name and note right — stacks on narrow screens. */
  wine: ({ name, meta, note, imageUrl }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           bgcolor="${e.surface}" style="background-color:${e.surface};border-radius:${layout.radius}px;">
      <tr>
        <td width="96" valign="top" style="padding:16px 0 16px 16px;">
          ${imageUrl
            ? `<img src="${esc(imageUrl)}" width="80" alt="${esc(name)}"
                 style="display:block;width:80px;height:auto;border:0;border-radius:2px;">`
            : `<div style="width:80px;height:104px;background-color:${e.rule};border-radius:2px;"></div>`}
        </td>
        <td valign="top" style="padding:16px;">
          <p style="margin:0;font-family:${t.displayStack};font-size:18px;line-height:1.25;
             text-transform:${t.headingCase};color:${e.ink};">${esc(name)}</p>
          ${meta ? `<p style="margin:4px 0 0;font-family:${t.bodyStack};font-size:12px;
             line-height:1.4;color:${e.inkMuted};">${esc(meta)}</p>` : ''}
          ${note ? `<p style="margin:10px 0 0;font-family:${t.bodyStack};font-size:14px;
             line-height:1.55;color:${e.ink};">${esc(note)}</p>` : ''}
        </td>
      </tr>
    </table>`, { padY: 8 }),

  /** An event. Date set apart so it survives a skim. */
  event: ({ date, title, detail }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border-left:3px solid ${palette.primary};">
      <tr><td style="padding:2px 0 2px 14px;">
        <p style="margin:0;font-family:${t.bodyStack};font-size:11px;line-height:1.4;
           letter-spacing:${t.trackingEyebrow};text-transform:uppercase;color:${palette.primary};">
          ${esc(date)}</p>
        <p style="margin:5px 0 0;font-family:${t.displayStack};font-size:18px;line-height:1.25;
           text-transform:${t.headingCase};color:${e.ink};">${esc(title)}</p>
        ${detail ? `<p style="margin:6px 0 0;font-family:${t.bodyStack};font-size:14px;
           line-height:1.55;color:${e.inkMuted};">${esc(detail)}</p>` : ''}
      </td></tr>
    </table>`, { padY: 10 }),

  /**
   * Call to action. Built as a table, not an <a> with padding — Outlook
   * collapses padding on inline elements and the button loses its shape.
   */
  button: ({ label, url }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
      <tr><td align="center" bgcolor="${palette.accent}"
              style="background-color:${palette.accent};border-radius:${layout.radius}px;">
        <a href="${esc(url)}" style="display:inline-block;padding:13px 28px;
           font-family:${t.bodyStack};font-size:14px;line-height:1;letter-spacing:.4px;
           color:${palette.onAccent};text-decoration:none;">${esc(label)}</a>
      </td></tr>
    </table>`, { padY: 12 }),

  /** Passthrough. Only used to place listmonk's content marker in the shell. */
  __raw__: ({ html }) => String(html ?? ''),

  divider: () => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="border-top:1px solid ${e.rule};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>`, { padY: 6 }),

  /** Tasting room hours — the most-asked question, so it earns a block. */
  hours: ({ heading = 'Visit us', rows = [] }) => row(`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td>
        ${eyebrow(heading)}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${rows.map((r) => `
          <tr>
            <td style="padding:5px 0;font-family:${t.bodyStack};font-size:14px;
                line-height:1.5;color:${e.ink};">${esc(r.label)}</td>
            <td align="right" style="padding:5px 0;font-family:${t.bodyStack};font-size:14px;
                line-height:1.5;color:${e.inkMuted};">${esc(r.value)}</td>
          </tr>`).join('')}
        </table>
      </td></tr>
    </table>`),
};

export default blocks;
