// The app imports the shared TypeScript SDK (../sdk) straight from source.
// https://docs.expo.dev/guides/monorepos/
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '../sdk');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), sdkRoot];
// Files in ../sdk resolve their (Babel-injected) dependencies from the app's node_modules.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@procurepilot/sdk': path.join(sdkRoot, 'src'),
};

module.exports = config;
