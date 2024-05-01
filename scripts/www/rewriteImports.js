/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

'use strict';

const fs = require('fs-extra');
const glob = require('glob');
const path = require('node:path');
const {packagesManager} = require('../shared/packagesManager');
const npmToWwwName = require('./npmToWwwName');
const {t, transform} = require('hermes-transform');

const wwwMappings = Object.fromEntries(
  packagesManager
    .getPublicPackages()
    .flatMap((pkg) =>
      pkg.getExportedNpmModuleNames().map((npm) => [npm, npmToWwwName(npm)]),
    ),
);

/**
 * It would be nice to use jscodeshift for this but the flow sources are using
 * ast features that are not supported in ast-types (as of 2024-04-11) so it's
 * not possible to traverse the tree and replace the imports & comments.
 *
 * It might be possible going straight to flow-parser, but it was a slew of
 * hardcoded regexps before and now it's at least automated based on the
 * exports.
 *
 * @param {string} source
 * @returns {Promise<string>} transformed source
 */
async function transformFlowFileContents(source) {
  return await transform(
    source,
    (context) => ({
      ImportDeclaration(node) {
        const value = wwwMappings[node.source.value];
        if (value) {
          context.replaceNode(node.source, t.StringLiteral({value}));
        }
      },
      Program(node) {
        if (
          node.docblock &&
          node.docblock.comment &&
          node.docblock.comment.value.includes('@flow strict')
        ) {
          node.docblock.comment.value = node.docblock.comment.value.replace(
            / \* @flow strict/g,
            ' * @flow strict\n * @generated\n * @oncall lexical_web_text_editor',
          );
          // Let the transform know we actually did something.
          // Could not figure out the right way to update the
          // docblock without an in-place update
          context.addLeadingComments(node, '');
        }
      },
    }),
    {},
  );
}

// This script attempts to find all Flow definition modules, and makes
// them compatible with www. Specifically, it finds any imports that
// reference lower case 'lexical' -> 'Lexical' and package references,
// such as 'lexical/Foo' -> 'LexicalFoo' and '@lexical/react/LexicalFoo' ->
// 'LexicalFoo'. Lastly, it creates these files in the 'dist' directory
// for each package so they can easily be copied to www.
async function rewriteImports() {
  for (const pkg of packagesManager.getPackages()) {
    for (const flowFile of glob.sync(pkg.resolve('flow', '*.flow'))) {
      const data = fs.readFileSync(flowFile, 'utf8');
      const result = await transformFlowFileContents(data);
      if (result.length > 0) {
        fs.writeFileSync(
          pkg.resolve('dist', path.basename(flowFile)),
          result,
          'utf8',
        );
      }
    }
  }
}

rewriteImports();
