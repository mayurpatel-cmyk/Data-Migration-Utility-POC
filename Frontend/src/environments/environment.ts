import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: false,
  apiUrl: 'http://vm-sureshift.ecamapps.net',
  wsUrl: 'ws://vm-sureshift.ecamapps.net'
};