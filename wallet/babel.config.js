module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxRuntime: 'automatic' }]],
    /* Reanimated's worklet plugin rewrites the animation callbacks that run on
     * the UI thread, and it has to be last. Every spring in this application
     * goes through it. */
    plugins: ['react-native-worklets/plugin'],
  };
};
