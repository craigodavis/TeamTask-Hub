/**
 * Catalog of named image slots on the website. The Team "Website Images" screen
 * renders these (grouped, with labels + aspect ratios); the site fills each slot
 * with a library image via kindred_web.page_images. Keep keys in sync with the
 * website's <SlotImage slot="..."> usage.
 */
export const IMAGE_SLOTS = [
  {
    group: 'Home',
    slots: [
      { key: 'home.hero', label: 'Hero background', hint: 'Full-width image behind the headline', ratio: '16 / 9' },
      { key: 'home.welcome', label: 'Welcome photo', hint: 'The family at a full table', ratio: '4 / 5' },
    ],
  },
  {
    group: 'Experience cards',
    slots: [
      { key: 'card.kitchen', label: "Nono's Kitchen", hint: 'Card image', ratio: '3 / 2' },
      { key: 'card.wine', label: 'Our Wine', hint: 'Card image', ratio: '3 / 2' },
      { key: 'card.reservations', label: 'Reservations', hint: 'Card image', ratio: '3 / 2' },
    ],
  },
];

export const ALL_SLOT_KEYS = new Set(IMAGE_SLOTS.flatMap((g) => g.slots.map((s) => s.key)));
