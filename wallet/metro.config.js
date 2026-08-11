/**
 * Metro has to be told that half of this application lives above it.
 *
 * The wire format and the key derivation are in `../src`, imported here as
 * `@vault/*`. That is not a build convenience: it is how "one implementation
 * of the address rules and one of the wire, shared by both halves" is made
 * true rather than asserted. Metro will not follow a path outside the project
 * root unless it is watching it, so it is watched, and the alias is resolved
 * from tsconfig's `paths` (Expo's Metro config reads those).
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const vaultRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(vaultRoot, 'src')];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];

module.exports = config;
