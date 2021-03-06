module.exports = {
  EXTRA_GAS_PERCENTAGE: 1,
  MAX_CONCURRENT_EVENTS: 50,
  RETRY_CONFIG: {
    retries: 20,
    factor: 1.4,
    maxTimeout: 360000,
    randomize: true
  },
  DEFAULT_UPDATE_INTERVAL: 600000,
  EXIT_CODES: {
    GENERAL_ERROR: 1,
    INCOMPATIBILITY: 10,
    MAX_TIME_REACHED: 11
  },
  GAS_PRICE_BOUNDARIES: {
    MIN: 1,
    MAX: 250
  },
  OBSERVABLE_METHODS: {
    transfer: {
      signature: '0xa9059cbb',
      callDataLength: 202
    },
    transferAndCall: {
      signature: '0x4000aea0',
      callDataLength: 330
    }
  },
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000'
}
