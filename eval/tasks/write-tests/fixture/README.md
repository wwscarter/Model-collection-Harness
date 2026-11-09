# Local synthetic arithmetic test fixture

This project is isolated evaluation data for ordinary algorithm test quality.
It contains no real user records, production measurements or external services.

The provided sum(values) implementation is correct. It adds all numeric values,
returns zero for an empty array, accepts negatives and fractions, and leaves the
input unchanged. Add native Node tests in test/sum.test.mjs. Preserve this file,
src/main.mjs, package.json and check.mjs.

Run npm test for the authored tests. Run node check.mjs to repeat those tests in
separate temporary copies using the correct source and deliberately incorrect
synthetic arithmetic variants. The checker removes every temporary copy.
