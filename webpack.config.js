//@ts-check
'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // VSCode extensions run in a Node.js-context
  mode: 'none',   // this leaves the source code as close as possible to the original

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log', // enables logging required for problem matchers
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded
    // ssh2 uses native Node.js addons (.node files) that cannot be bundled by webpack.
    // We keep the entire ssh2 package (and its transitive deps) unbundled so that
    // Node can load the prebuilt binaries at runtime via the normal require() path.
    ssh2: 'commonjs ssh2',
    'cpu-features': 'commonjs cpu-features'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  }
};

module.exports = config;
