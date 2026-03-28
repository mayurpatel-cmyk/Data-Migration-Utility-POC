// config/mappings.js

const COUNTRY_MAP = {
  'usa': 'United States',
  'u.s.a.': 'United States',
  'us': 'United States',
  'united states of america': 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'can': 'Canada',
  // Add as many as your organization needs
};

const STATE_MAP = {
  'california': 'CA',
  'calif': 'CA',
  'calif.': 'CA',
  'new york': 'NY',
  'texas': 'TX',
  'florida': 'FL',
  'fl.': 'FL',
  'ontario': 'ON',
  // Add as many as your organization needs
};

const RECORD_TYPE_MAP = {
  'Account': {
    'B2B Customer': '01250000000XXXXAAA',
    'Partner': '01250000000YYYYAAA',
    'Vendor': '01250000000ZZZZAAA'
  },
  'Contact': {
    'Standard': '01250000000AAAAAAA',
    'Executive': '01250000000BBBBAAA'
  },
  'Opportunity': {
    'New Business': '01250000000CCCCAAA',
    'Renewal': '01250000000DDDDAAA'
  }
};

module.exports = {
  COUNTRY_MAP,
  STATE_MAP,
  RECORD_TYPE_MAP
};