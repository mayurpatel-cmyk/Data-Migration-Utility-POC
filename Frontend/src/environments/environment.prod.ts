import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: true,
  apiUrl: 'https://YOUR-API-ID.execute-api.us-east-1.amazonaws.com/dev' 
};
