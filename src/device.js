// -----------------------------------------------------------------------------
// The one Gladys device of the integration: the recalls of the followed
// selection (categories, brands or words, vehicles).
//
// Features (couples checked against the Gladys front, see
// test/gladys-rules.test.js):
//   - recalls_week     counter-sensor/integer: recalls of the selection whose
//                      day (CPSC recall date, FDA report date, NHTSA report
//                      received) is one of the last 7 days, today included,
//                      in the time zone of Gladys;
//   - vehicle_recalls  counter-sensor/integer: recall campaigns NHTSA lists
//                      for the followed vehicles, all years (no state when no
//                      vehicle is followed);
//   - latest_recall    text/text: the newest recall of the 7 days, with its day.
//
// Published with should_poll: false: the refresh runs in the container
// (src/monitor.js). The platform id is fixed: there is one selection per Gladys.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'recalls';
export const PLATFORM_ID = 'selection';
export const FEATURE_KEYS = {
  WEEK: 'recalls_week',
  VEHICLES: 'vehicle_recalls',
  LATEST: 'latest_recall',
};

export const MAX_COUNT = 10000;

// Feature names, frozen at creation in Gladys (language of the configuration).
export const NAMES = {
  en: {
    device: 'Recalls in the United States',
    recalls_week: 'Recalls in 7 days',
    vehicle_recalls: 'Vehicle recall campaigns',
    latest_recall: 'Latest recall',
  },
  fr: {
    device: 'Rappels aux États-Unis',
    recalls_week: 'Rappels sur 7 jours',
    vehicle_recalls: 'Campagnes de rappel des véhicules',
    latest_recall: 'Dernier rappel',
  },
};

/** External ids of the device and of its features. */
export function deviceIds(gladys) {
  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  return {
    device: ids.device,
    week: ids.feature(FEATURE_KEYS.WEEK),
    vehicles: ids.feature(FEATURE_KEYS.VEHICLES),
    latest: ids.feature(FEATURE_KEYS.LATEST),
  };
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

/** The discovery payload of the device. */
export function buildDevice(gladys, language = 'en') {
  const ids = deviceIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  const counter = (name, id) =>
    sensor(name, id, DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR, TYPES.SENSOR.INTEGER, {
      keep_history: true,
      min: 0,
      max: MAX_COUNT,
    });
  return {
    name: names.device,
    external_id: ids.device,
    model: 'CPSC, FDA and NHTSA open data',
    should_poll: false,
    params: [],
    features: [
      counter(names.recalls_week, ids.week),
      counter(names.vehicle_recalls, ids.vehicles),
      sensor(names.latest_recall, ids.latest, DEVICE_FEATURE_CATEGORIES.TEXT, TYPES.TEXT.TEXT, {
        keep_history: false,
        min: 0,
        max: 0,
      }),
    ],
  };
}
