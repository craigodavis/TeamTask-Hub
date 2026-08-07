/**
 * Assemble blocks into a sendable email.
 *
 * renderEmail([{ type, ...props }]) -> full HTML document.
 *
 * The wrapper is where the unglamorous correctness lives: the preheader, the
 * 600px table, the footer, and the unsubscribe link. Unsubscribe is added by
 * the renderer rather than being a block someone remembers to drop in — it is a
 * legal requirement under CAN-SPAM, and the single fastest way to wreck a
 * sending reputation is mail people cannot get off. It is not a design choice,
 * so it is not offered as one.
 */

import blocks from './blocks.js';
import { palette, emailOnly as e, type as t, layout, business } from './brand.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * The line shown in the inbox after the subject. Left unset it fills with
 * whatever text comes first — usually "View in browser", which wastes the most
 * valuable real estate an email has.
 */
const preheader = (text) => `
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;
     font-size:1px;line-height:1px;color:${e.canvas};opacity:0;">
  ${esc(text || '')}
  ${'&#847;&zwnj;&nbsp;'.repeat(60)}
</div>`;

const footer = ({ unsubscribeUrl, browserUrl }) => `
<tr>
  <td align="center" style="padding:26px ${layout.gutter}px 34px;border-top:1px solid ${e.rule};">
    <p style="margin:0 0 6px;font-family:${t.displayStack};font-size:14px;line-height:1.4;
       text-transform:${t.headingCase};color:${e.ink};">${esc(business.name)}</p>
    <p style="margin:0 0 12px;font-family:${t.bodyStack};font-size:12px;line-height:1.5;
       color:${e.inkMuted};font-style:italic;">${esc(business.tagline)}</p>
    <p style="margin:0 0 12px;font-family:${t.bodyStack};font-size:12px;line-height:1.5;
       color:${e.inkMuted};">${esc(business.address)}</p>
    <p style="margin:0;font-family:${t.bodyStack};font-size:12px;line-height:1.6;color:${e.inkMuted};">
      <a href="${esc(unsubscribeUrl)}" style="color:${e.inkMuted};text-decoration:underline;">Unsubscribe</a>
      ${browserUrl ? ` &nbsp;·&nbsp; <a href="${esc(browserUrl)}"
        style="color:${e.inkMuted};text-decoration:underline;">View in browser</a>` : ''}
    </p>
  </td>
</tr>`;

/**
 * @param {Array<{type:string}>} sections
 * @param {object} opts  subject, preheader, unsubscribeUrl, browserUrl
 */
export function renderEmail(sections = [], opts = {}) {
  const {
    subject = '',
    preheader: pre = '',
    // listmonk substitutes these when it sends; the default keeps a preview
    // honest about the fact that a real unsubscribe link belongs here.
    unsubscribeUrl = '{{ UnsubscribeURL }}',
    browserUrl = '{{ MessageURL }}',
  } = opts;

  const body = sections.map((s) => {
    const fn = blocks[s.type];
    if (!fn) throw new Error(`Unknown email block: "${s.type}"`);
    return fn(s);
  }).join('');

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
<title>${esc(subject)}</title>
<!--[if mso]><style>body,table,td{font-family:Georgia,serif !important;}</style><![endif]-->
<style>
  body{margin:0;padding:0;width:100% !important;-webkit-text-size-adjust:100%;}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
  a{color:${palette.accent};}
  @media only screen and (max-width:620px){
    .kv-shell{width:100% !important;}
    .kv-stack{display:block !important;width:100% !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${e.canvas};">
${preheader(pre)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       bgcolor="${e.canvas}" style="background-color:${e.canvas};">
  <tr><td align="center" style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${layout.width}"
           class="kv-shell" style="width:${layout.width}px;max-width:${layout.width}px;">
      ${body}
      ${footer({ unsubscribeUrl, browserUrl })}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Just the blocks, no wrapper — what TeamHub pushes into a listmonk campaign.
 */
export function renderBody(sections = []) {
  return sections.map((s) => {
    const fn = blocks[s.type];
    if (!fn) throw new Error(`Unknown email block: "${s.type}"`);
    return fn(s);
  }).join('');
}

/**
 * The same wrapper, emitted as a listmonk template.
 *
 * listmonk requires the literal `{{ template "content" . }}` and substitutes
 * campaign HTML there. Keeping the shell on listmonk's side rather than
 * rendering whole emails in TeamHub means unsubscribe, the browser view and
 * click tracking are produced by the thing that actually knows about them —
 * TeamHub would otherwise be writing URLs it cannot honour, and a wrong
 * unsubscribe link is worse than none.
 */
export function listmonkTemplate() {
  const marker = '__LISTMONK_CONTENT__';
  return renderEmail([{ type: '__raw__', html: marker }], {
    subject: '{{ .Campaign.Subject }}',
    preheader: '{{ .Campaign.Subject }}',
    unsubscribeUrl: '{{ UnsubscribeURL }}',
    browserUrl: '{{ MessageURL }}',
  }).replace(marker, '{{ template "content" . }}');
}

export default renderEmail;
