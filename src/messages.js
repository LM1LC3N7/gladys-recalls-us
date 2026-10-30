// -----------------------------------------------------------------------------
// Texts sent from the container (feature values, connection status, action and
// scene messages, scene variables), in English and French. The recalls come
// from CPSC, the FDA and NHTSA in English: their titles, products and reasons
// are shown as published.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';

// Short enough for a widget badge (16 characters).
export const CATEGORY_NAMES = {
  en: {
    consumer: 'Consumer product',
    food: 'Food',
    drugs: 'Drug',
    devices: 'Medical device',
    vehicles: 'Vehicle',
  },
  fr: {
    consumer: 'Consommation',
    food: 'Aliment',
    drugs: 'Médicament',
    devices: 'Dispositif méd.',
    vehicles: 'Véhicule',
  },
};

export const COLORS = { recall: WIDGET_COLORS.WARNING };

// Names of the feeds in the texts. A vehicle is named by its make, model and
// year, or by its position when it was given as a VIN and is not decoded yet.
const FEED_NAMES = {
  en: {
    cpsc: 'CPSC (consumer products)',
    'fda-food': 'FDA (food)',
    'fda-drug': 'FDA (drugs)',
    'fda-device': 'FDA (medical devices)',
    vehicle: ({ label }) => `NHTSA (${label})`,
    vin: ({ position }) => `NHTSA (VIN ${position})`,
  },
  fr: {
    cpsc: 'CPSC (produits de consommation)',
    'fda-food': 'FDA (aliments)',
    'fda-drug': 'FDA (médicaments)',
    'fda-device': 'FDA (dispositifs médicaux)',
    vehicle: ({ label }) => `NHTSA (${label})`,
    vin: ({ position }) => `NHTSA (NIV ${position})`,
  },
};

/** The name of a feed `{ id, label?, position? }` in one language. */
export function feedName(feed, language) {
  const names = FEED_NAMES[language];
  if (feed.position !== undefined) {
    return names.vin(feed);
  }
  if (feed.label !== undefined && feed.id.startsWith('vehicle:')) {
    return names.vehicle(feed);
  }
  return names[feed.id] ?? feed.id;
}

export const PHRASES = {
  en: {
    none: 'No recall in the last 7 days',
    recalls: ({ count }) => (count === 1 ? '1 recall in 7 days' : `${count} recalls in 7 days`),
    noRecall: 'No recall in your selection over the last 7 days.',
    list: ({ head, items }) => `${head}: ${items.join('; ')}.`,
    more: ({ count }) => `and ${count} more`,
    summary: ({ title, issue }) =>
      issue
        ? `Recall in the United States: ${title}. ${issue}`
        : `Recall in the United States: ${title}.`,
    vehicles: ({ items }) => `Your vehicles: ${items.join('; ')}.`,
    vehicle: ({ label, count, day }) =>
      count === 0
        ? `${label}, no recall campaign known to NHTSA`
        : `${label}, ${count === 1 ? '1 recall campaign' : `${count} recall campaigns`}${day ? `, the latest received on ${day}` : ''}`,
  },
  fr: {
    none: 'Aucun rappel ces 7 derniers jours',
    recalls: ({ count }) => (count === 1 ? '1 rappel sur 7 jours' : `${count} rappels sur 7 jours`),
    noRecall: 'Aucun rappel dans votre sélection ces 7 derniers jours.',
    list: ({ head, items }) => `${head} : ${items.join(' ; ')}.`,
    more: ({ count }) => `et ${count} de plus`,
    summary: ({ title, issue }) =>
      issue ? `Rappel aux États-Unis : ${title}. ${issue}` : `Rappel aux États-Unis : ${title}.`,
    vehicles: ({ items }) => `Vos véhicules : ${items.join(' ; ')}.`,
    vehicle: ({ label, count, day }) =>
      count === 0
        ? `${label}, aucune campagne de rappel connue de la NHTSA`
        : `${label}, ${count === 1 ? '1 campagne de rappel' : `${count} campagnes de rappel`}${day ? `, la dernière reçue le ${day}` : ''}`,
  },
};

// Connection status and action messages.
export const STATUS = {
  en: {
    initFailed: 'Cannot read the configuration from Gladys: trying again.',
    feedDown: ({ name, error }) => `${name} cannot be read (${error}).`,
    paused: ({ name, time }) => `${name} asked to wait: next try at ${time}.`,
    vinFailed: ({ name, error }) => `${name}: the VIN cannot be decoded (${error}).`,
    waiting: ({ names }) => `Waiting for the first reading of ${names}.`,
    stale: ({ name, day }) =>
      `${name} has not been updated since ${day}: the counters are not published until it is.`,
    nothingFollowed: 'Nothing is followed: tick a category or add a vehicle.',
    invalidVehicles: ({ positions }) =>
      `Vehicle entries not understood (expected "make, model, year"): ${positions}.`,
    invalidVins: ({ positions }) => `VINs that are not 17 valid characters: ${positions}.`,
    tooManyVehicles: ({ count }) => `More than 5 vehicles (3 by VIN at most): ${count} left out.`,
    noCampaign: ({ names }) =>
      `No recall campaign known to NHTSA for ${names}: check the make and the model as NHTSA spells them.`,
    dataUnreadable:
      'The memory of the integration (/data) cannot be read: the recalls already seen are not known, nothing fires before a new reading.',
    dataUnwritable:
      'The memory of the integration (/data) cannot be written: after a restart, the recalls already seen are forgotten.',
    truncated: ({ names }) =>
      `More recalls than read for ${names}: some are left out (beyond 1,000 an answer).`,
    dataHung:
      'The memory of the integration (/data) does not answer: the readings go on, what was seen may be lost at a restart.',
    eventsDropped: ({ names }) =>
      `More than 200 new recalls waiting for Gladys for ${names}: the oldest were dropped, never sent.`,
    notYet: ({ names }) => `Not read yet: ${names}.`,
    old: ({ items }) => `The recalls are not up to date: ${items}.`,
    oldItem: ({ name, time }) => `${name} last read on ${time}`,
    staleItem: ({ name, day }) => `${name} not updated since ${day}`,
    lastFailed: ({ items }) => `Warning: the last reading failed for ${items}.`,
    lastFailedItem: ({ name, error, time }) => `${name} (${error}; recalls of ${time})`,
    summary: ({ text, time }) => `${text} Read at ${time}.`,
  },
  fr: {
    initFailed: 'Impossible de lire la configuration depuis Gladys : nouvel essai en cours.',
    feedDown: ({ name, error }) => `${name} est illisible (${error}).`,
    paused: ({ name, time }) => `${name} demande d’attendre : prochain essai à ${time}.`,
    vinFailed: ({ name, error }) => `${name} : le NIV ne peut pas être décodé (${error}).`,
    waiting: ({ names }) => `En attente de la première lecture de ${names}.`,
    stale: ({ name, day }) =>
      `${name} n’a pas été mis à jour depuis le ${day} : les compteurs ne sont plus publiés jusqu’à sa mise à jour.`,
    nothingFollowed: 'Rien n’est suivi : cochez une catégorie ou ajoutez un véhicule.',
    invalidVehicles: ({ positions }) =>
      `Véhicules non compris (format attendu « marque, modèle, année ») : ${positions}.`,
    invalidVins: ({ positions }) => `NIV qui ne font pas 17 caractères valides : ${positions}.`,
    tooManyVehicles: ({ count }) =>
      `Plus de 5 véhicules (dont 3 par NIV au plus) : ${count} laissé(s) de côté.`,
    noCampaign: ({ names }) =>
      `Aucune campagne de rappel connue de la NHTSA pour ${names} : vérifiez la marque et le modèle tels que la NHTSA les écrit.`,
    dataUnreadable:
      'La mémoire de l’intégration (/data) est illisible : les rappels déjà vus sont inconnus, rien n’est déclenché avant une nouvelle lecture.',
    dataUnwritable:
      'La mémoire de l’intégration (/data) ne peut pas être écrite : après un redémarrage, les rappels déjà vus sont oubliés.',
    truncated: ({ names }) =>
      `Plus de rappels que lus pour ${names} : certains sont ignorés (au-delà de 1 000 par réponse).`,
    dataHung:
      'La mémoire de l’intégration (/data) ne répond pas : les lectures continuent, ce qui a été vu peut être perdu au redémarrage.',
    eventsDropped: ({ names }) =>
      `Plus de 200 nouveaux rappels en attente de Gladys pour ${names} : les plus anciens ont été abandonnés, jamais envoyés.`,
    notYet: ({ names }) => `Pas encore lu : ${names}.`,
    old: ({ items }) => `Les rappels ne sont pas à jour : ${items}.`,
    oldItem: ({ name, time }) => `${name} lu pour la dernière fois le ${time}`,
    staleItem: ({ name, day }) => `${name} non mis à jour depuis le ${day}`,
    lastFailed: ({ items }) => `Attention : la dernière lecture a échoué pour ${items}.`,
    lastFailedItem: ({ name, error, time }) => `${name} (${error} ; rappels du ${time})`,
    summary: ({ text, time }) => `${text} Lu à ${time}.`,
  },
};

// What went wrong, said for people (never a raw code).
export const ERRORS = {
  en: {
    network: 'the connection failed',
    dns: 'the server name cannot be found (DNS)',
    refused: 'the connection was refused',
    closed: 'the connection was cut by the server',
    timeout: 'no answer in time',
    stalled: 'the answer stopped halfway',
    tooLong: 'the answer took too long',
    redirect: 'the server redirects elsewhere',
    http: ({ status }) => `the server answered with an error (HTTP ${status})`,
    size: 'the answer is far larger than expected',
    format: 'the answer is not in the expected format',
    vinUnknown: 'NHTSA does not know its make, model or year',
    stopped: 'the integration stopped',
  },
  fr: {
    network: 'la connexion a échoué',
    dns: 'le nom du serveur est introuvable (DNS)',
    refused: 'la connexion a été refusée',
    closed: 'la connexion a été coupée par le serveur',
    timeout: 'pas de réponse à temps',
    stalled: 'la réponse s’est arrêtée en route',
    tooLong: 'la réponse a pris trop de temps',
    redirect: 'le serveur redirige ailleurs',
    http: ({ status }) => `le serveur a répondu par une erreur (HTTP ${status})`,
    size: 'la réponse est bien plus grosse que prévu',
    format: 'la réponse n’a pas le format attendu',
    vinUnknown: 'la NHTSA ne connaît pas sa marque, son modèle ou son année',
    stopped: 'l’intégration s’est arrêtée',
  },
};

/** An error `{ kind, status }` in one language. */
export function describeError(error, language) {
  const entry = ERRORS[language][error.kind] ?? ERRORS[language].network;
  return typeof entry === 'function' ? entry(error) : entry;
}

/** One entry of a message table, in every language: `{ en, fr }`. */
export function render(table, key, params = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const entry = table[language][key];
      return [language, typeof entry === 'function' ? entry(params) : entry];
    }),
  );
}

/** One entry in every language, with parameters computed per language. */
export function renderEach(table, key, paramsOf) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [language, table[language][key](paramsOf(language))]),
  );
}

/** Several multi-language texts joined, language by language. */
export function join(...messages) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      messages
        .filter(Boolean)
        .map((message) => message[language])
        .join(' '),
    ]),
  );
}

/** A list of names: "a, b and c" / "a, b et c". */
export function listOf(items, language) {
  if (items.length <= 1) {
    return items.join('');
  }
  const and = language === 'fr' ? ' et ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${and}${items.at(-1)}`;
}

const locale = (language) => (language === 'en' ? 'en-US' : 'fr-FR');

/** A source day "2026-10-28" written for people: "Oct 28, 2026" / "28 oct. 2026". */
export function formatSourceDay(day, language) {
  if (!day) {
    return '';
  }
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A date and a time in the user's time zone (TZ, set by the Gladys supervisor). */
export function formatDate(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

/** A time of day, e.g. "18:35". */
export function formatTime(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(time));
}

/** The calendar day of a time in the user's time zone, "2026-10-20". */
export function localDay(time) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

/** The day `days` calendar days before `day` ("2026-10-20", 7 → "2026-10-13"). */
export function dayBefore(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The value of the "Latest recall" feature: "Oct 28, 2026 · DREO Recalls …". */
export function describe(recall, language) {
  const day = formatSourceDay(recall.day, language);
  return clip(day ? `${day} · ${recall.title}` : recall.title, 200);
}

// Recalls named in one sentence: a scene that reads it aloud stays short.
export const SENTENCE_RECALLS = 5;

/** The recalls of the last 7 days as one sentence, newest first. */
export function sentence(recalls, language) {
  const p = PHRASES[language];
  if (recalls.length === 0) {
    return p.noRecall;
  }
  const items = recalls.slice(0, SENTENCE_RECALLS).map((recall) => clip(recall.title, 120));
  const rest = recalls.length - SENTENCE_RECALLS;
  if (rest > 0) {
    items.push(p.more({ count: rest }));
  }
  return p.list({ head: p.recalls({ count: recalls.length }), items });
}

/** The followed vehicles in one sentence: `[{ label, records }]`. */
export function vehiclesSentence(vehicles, language) {
  if (vehicles.length === 0) {
    return '';
  }
  const p = PHRASES[language];
  return p.vehicles({
    items: vehicles.map(({ label, records }) =>
      p.vehicle({
        label,
        count: records.length,
        day: formatSourceDay(records[0]?.day ?? null, language),
      }),
    ),
  });
}
