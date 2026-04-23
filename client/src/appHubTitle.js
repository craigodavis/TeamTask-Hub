/** Label for header / document title: DB company name, then humanized slug, then null. */
export function companyDisplayLabel(user) {
  if (!user || typeof user !== 'object') return null;
  const fromName =
    (user.company_name != null && String(user.company_name).trim()) ||
    (user.companyName != null && String(user.companyName).trim()) ||
    '';
  if (fromName) return fromName;
  const slug = user.company_slug ?? user.companySlug;
  if (slug != null && String(slug).trim()) {
    return String(slug)
      .trim()
      .split(/[-_]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(' ');
  }
  return null;
}

export function appHubTitle(user) {
  const label = companyDisplayLabel(user);
  return label ? `${label} Team Hub` : 'Team Hub';
}
