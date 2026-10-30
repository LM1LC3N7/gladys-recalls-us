// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `recalls`.
//
// A heading with the number of recalls of the last 7 days, then the rows as a
// `card-list` (8 at most, the core's cap): the recalls of the 7 days, newest
// first, then the latest campaigns of the followed vehicles. The badge gives
// the category (red for an FDA Class I recall, or a vehicle NHTSA advises to
// park). Tapping a row opens the core's detail panel: reason, class, remedy,
// and the link to the sheet. The footer gives the sources and the time of the
// oldest reading shown; a button opens recalls.gov.
// Budget: 2 texts, 1 card-list, 1 button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { CATEGORY_NAMES, COLORS, clip, formatDate, formatSourceDay } from './messages.js';
import { WIDGET_KEY } from './monitor.js';

export const MAX_ITEMS = 8;
export const TTL_SECONDS = 600;
export const SITE_URL = 'https://www.recalls.gov';

export const TEXT = {
  waiting: { en: 'Waiting for the sources…', fr: 'En attente des sources…' },
  notUpToDate: { en: 'Recalls not up to date', fr: 'Rappels non à jour' },
  nothing: { en: 'Nothing followed', fr: 'Rien n’est suivi' },
  none: { en: 'No recall in 7 days', fr: 'Aucun rappel sur 7 jours' },
  one: { en: '1 recall in 7 days', fr: '1 rappel sur 7 jours' },
  many: { en: ' recalls in 7 days', fr: ' rappels sur 7 jours' },
  source: { en: 'CPSC, FDA, NHTSA', fr: 'CPSC, FDA, NHTSA' },
  sheet: { en: 'Recall sheet', fr: 'Fiche de rappel' },
  issue: { en: 'Reason', fr: 'Motif' },
  recallClass: { en: 'Class', fr: 'Classe' },
  remedy: { en: 'Remedy', fr: 'Remède' },
  firm: { en: 'Firm', fr: 'Entreprise' },
  day: { en: 'Date', fr: 'Date' },
  site: { en: 'Recalls.gov', fr: 'Recalls.gov' },
};

const t = (text, language) => text[language] ?? text.en;

function heading(count, language) {
  if (count === 0) {
    return t(TEXT.none, language);
  }
  return count === 1 ? t(TEXT.one, language) : `${count}${t(TEXT.many, language)}`;
}

/** One row of the list, and its detail panel. */
export function itemOf(recall, language) {
  const colon = language === 'fr' ? ' : ' : ': ';
  const field = (label, value) => (value ? `${t(label, language)}${colon}${value}` : null);
  const day = formatSourceDay(recall.day, language);
  return {
    title: clip(recall.title, 60),
    subtitle: clip([day, recall.firm].filter(Boolean).join(' · '), 60),
    badge: {
      text: CATEGORY_NAMES[language][recall.category],
      color: recall.serious ? WIDGET_COLORS.DANGER : COLORS.recall,
    },
    description: clip(
      [
        field(TEXT.issue, recall.issue),
        field(TEXT.recallClass, recall.recallClass),
        field(TEXT.remedy, recall.remedy),
        field(TEXT.firm, recall.firm),
        field(TEXT.day, day),
      ]
        .filter(Boolean)
        .join('\n'),
      2000,
    ),
    links: [{ url: recall.url, label: t(TEXT.sheet, language) }],
  };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    async get(monitor, { language = 'en' } = {}) {
      const lang = language === 'fr' ? 'fr' : 'en';
      const { recalls, vehicles, freshness, warning, readAt } = monitor.snapshot();
      // Never "no recall" from data that is not up to date: the heading says so.
      let title = heading(recalls.length, lang);
      if (freshness === 'empty') {
        title = t(TEXT.nothing, lang);
      } else if (freshness === 'none') {
        title = t(TEXT.waiting, lang);
      } else if (freshness !== 'fresh') {
        title = t(TEXT.notUpToDate, lang);
      }
      const components = [{ type: 'text', variant: 'heading', text: title }];
      const shown = new Set(recalls.map((recall) => `${recall.feed}:${recall.id}`));
      const campaigns = vehicles
        .flatMap((vehicle) => vehicle.records)
        .filter((recall) => !shown.has(`${recall.feed}:${recall.id}`))
        .sort((a, b) => (b.day ?? '').localeCompare(a.day ?? ''));
      const rows = [...recalls, ...campaigns].slice(0, MAX_ITEMS).map((r) => itemOf(r, lang));
      if (rows.length > 0) {
        components.push({ type: 'card-list', display: 'list', items: rows });
      }
      const caption = [t(TEXT.source, lang)];
      if (readAt !== null) {
        caption.push(formatDate(readAt, lang));
      }
      if (freshness !== 'none' && warning !== null) {
        caption.push(warning[lang]);
      }
      components.push(
        { type: 'text', variant: 'caption', text: clip(caption.join(' · '), 80) },
        {
          type: 'button',
          label: t(TEXT.site, lang),
          icon: 'external-link',
          link: { url: SITE_URL },
        },
      );
      return { ttl_seconds: TTL_SECONDS, components };
    },
  },
};
