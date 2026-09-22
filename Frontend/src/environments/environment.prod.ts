import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: true,
  apiUrl: 'http://sureshift-demo:8000',
  wsUrl: 'ws://sureshift-demo:8000'
};
