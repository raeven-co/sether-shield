// Test-only shim: re-exports the alias engine from the exact @raeven-co/sether
// build the shield bundles, so the lifecycle test exercises the same code that
// ships in content.js.
export { suggestAliases, aliasValue, shapeAlias, AliasVault } from '@raeven-co/sether/browser';
