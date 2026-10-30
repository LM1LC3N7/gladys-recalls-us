// -----------------------------------------------------------------------------
// The scene action `read_recalls` and the configuration action `check_now`.
// Both answer from the last readings, without asking the sources again (each
// is read on its own schedule, never faster), with the recalls of the last 7
// days and the campaigns of the followed vehicles as one sentence: something
// a scene can send by message or read aloud, newest first. Recalls that are
// not up to date (a source read too long ago, never read, or stale) are never
// given as current: the scene action fails with the reason, the configuration
// action says it instead of a count.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';
import { STATUS, formatDate, sentence, vehiclesSentence } from './messages.js';

const logger = createLogger({ name: 'recalls-us-actions' });

export const SCENE_ACTION = 'read_recalls';
export const CONFIG_ACTION = 'check_now';

const textOf = ({ recalls, vehicles }, language) =>
  [sentence(recalls, language), vehiclesSentence(vehicles, language)].filter(Boolean).join(' ');

/** Scene action: outputs `text`, `count` and, with vehicles, `vehicle_count`; throws unless up to date. */
export async function readRecalls(monitor) {
  const snapshot = monitor.snapshot();
  const { recalls, vehicles, freshness, warning } = snapshot;
  const language = monitor.config.language;
  if (freshness !== 'fresh') {
    throw new Error(warning[language]);
  }
  const text = textOf(snapshot, language);
  return {
    // A failed last reading while the recalls are still fresh: said first.
    text: warning ? `${warning[language]} ${text}` : text,
    count: recalls.length,
    // Absent when no vehicle is followed (never a 0 that would read as "no
    // campaign", never a sentinel).
    ...(snapshot.followsVehicles
      ? { vehicle_count: vehicles.reduce((sum, vehicle) => sum + vehicle.records.length, 0) }
      : {}),
  };
}

/** Configuration action: the recalls of the selection, in every language. */
export async function checkNow(monitor) {
  const snapshot = monitor.snapshot();
  const { recalls, freshness, warning, readAt } = snapshot;
  logger.info(
    `Check requested: ${freshness === 'fresh' ? `${recalls.length} recall(s) in 7 days` : `recalls ${freshness}`}`,
  );
  if (freshness !== 'fresh') {
    return warning;
  }
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      [
        warning?.[language],
        STATUS[language].summary({
          text: textOf(snapshot, language),
          time: formatDate(readAt, language),
        }),
      ]
        .filter(Boolean)
        .join(' '),
    ]),
  );
}
