/**
 * Kindred brand tokens, compiled for email.
 *
 * SOURCE OF TRUTH is kindred-design-tokens.css in the website repo. These are
 * literal copies, not a second opinion — when that file changes, change this
 * and re-render. `npm run email:check-tokens` diffs the two.
 *
 * They are copied rather than imported for a reason that is specific to email:
 * mail clients do not support CSS custom properties. `var(--color-primary)` is
 * dead on arrival in Outlook and most webmail, so every value has to be a
 * literal inlined at build time. Tokens cannot cascade into an email; they have
 * to be compiled into one.
 */

/** Straight from the brand file. */
export const palette = {
  primary:   '#C19878',  // gold/tan — rules, eyebrows, accents
  accent:    '#006489',  // teal — the call to action, and only that
  bg:        '#0B1315',  // near-black — the website's canvas
  bgAlt:     '#131E21',
  cream:     '#FEF4D9',  // warm cream — headings on dark
  textOnDark:'#93918B',
  muted:     '#69727D',
  border:    '#1E2A2C',
  onAccent:  '#FFFFFF',
};

/**
 * Email-only tokens the brand file does not yet define.
 *
 * The website is dark, so every text colour in the source file is tuned for a
 * near-black background. An email on a light canvas needs the inverse, and
 * #93918B on cream is far too pale to read. These are derived from the existing
 * palette rather than invented — ink is the page background lightened just off
 * true black so it reads as warm rather than clinical.
 *
 * FLAG: these belong in kindred-design-tokens.css as --color-ink and
 * --color-ink-muted. Until they are there, web and email disagree about what
 * "body text" means and only this file knows the difference.
 */
export const emailOnly = {
  canvas:    '#FEF4D9',  // cream — the email's page, where the site uses near-black
  surface:   '#FFFFFF',  // cards sitting on the cream
  ink:       '#1A2124',  // body copy on light
  inkMuted:  '#5F6A6E',  // captions, legal, meta
  rule:      '#E4D8BC',  // cream darkened — dividers that do not shout
};

/** Type. Print faces are deliberately absent — see fontStacks below. */
export const type = {
  displayStack: "'Cormorant Garamond', Cormorant, Georgia, 'Times New Roman', serif",
  bodyStack:    "Jost, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  headingCase:  'uppercase',   // brand rule: display headings render in caps
  trackingEyebrow: '1.7px',
};

/**
 * Why the stacks look like that.
 *
 * Cormorant and Jost are Google Fonts. They render in Apple Mail and some
 * webmail and are ignored entirely by Outlook, which draws through Word. The
 * fallback is therefore not a formality — for a large share of recipients it IS
 * the typeface. Georgia and Helvetica are named explicitly so that Outlook
 * lands somewhere chosen rather than defaulting to Times New Roman.
 *
 * Trajan Pro, Recherche and Adobe Arabic are absent on purpose. They are
 * licensed desktop faces with no webfont delivery, so they cannot appear in
 * email at all. Print keeps them; email uses the web pairing. Same colours,
 * same layout, different type — that is as close as the two media get, and
 * pretending otherwise produces a mail that silently falls back to Times.
 */

export const layout = {
  width: 600,            // the width every mail client agrees on
  gutter: 24,
  radius: 3,             // Outlook square-ends anything larger; keep it modest
};

/** One place for the legally required footer content. */
export const business = {
  name: 'Kindred Vineyards',
  tagline: 'Always longer tables, never higher fences.',
  address: '14251 Frost Road, Caldwell, ID 83607',
};

export const brand = { palette, emailOnly, type, layout, business };
export default brand;
