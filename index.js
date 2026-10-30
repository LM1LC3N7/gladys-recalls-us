// -----------------------------------------------------------------------------
// Entry point: wires the Gladys SDK to the monitor (src/app.js). No logic here.
// Handlers are registered before connect().
//
// Environment provided by the Gladys supervisor: GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR (read by the SDK), and
// TZ, the time zone of Gladys (the days of "recalls in 7 days" and the times
// of the widget and the messages).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const app = registerHandlers(gladys);

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, stopping`);
  return app.stop(); // stops the timers, waits for the last write under /data
});

logger.info('Starting the Recalls in the United States integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
