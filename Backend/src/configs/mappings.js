const COUNTRY_MAP = {
  // United States -> 'US'
  'usa': 'US',
  'u.s.a.': 'US',
  'us': 'US',
  'united states of america': 'US',
  'united states': 'US',
  
  'uk': 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  'united kingdom': 'GB',
  
  // Canada -> 'CA'
  'can': 'CA',
  'canada': 'CA'
};

const STATE_MAP = {
  // California -> 'CA'
  'california': 'CA',
  'calif': 'CA',
  'calif.': 'CA',
  
  // New York -> 'NY'
  'new york': 'NY',
  'ny': 'NY',
  
  // Texas -> 'TX'
  'texas': 'TX',
  'tx': 'TX',
  
  'london': 'ENG',
};

const RECORD_TYPE_MAP = {
  'Account': {
    'B2B Customer': '012gL000001quLhQAI',
    'Partner': '012gL000001quLhQAI',
    'Vendor': '012gL000001quLiQAI'
  },
  'Contact': {
    'Standard': '012gL000001quLhQAI',
    'Executive': '012gL000001quLiQAI'
  },
  'Opportunity': {
    'New Business': '012gL000001quLhQAI',
    'Renewal': '012gL000001quLiQAI'
  }
};

module.exports = {
  COUNTRY_MAP,
  STATE_MAP,
  RECORD_TYPE_MAP
};
