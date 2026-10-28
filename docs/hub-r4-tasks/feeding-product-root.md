# Check the declared product root before binding a fed case

The declared agile directory grammar requires the directory root to equal one of the product pack's published names. The new directory binding must not assign a case under a different or missing root to this product merely because a folder has the same version form. Keep the case object and the source; leave its version undeclared with a missing fact and next action. Use the exact existing product-name declaration, not a mapping or fuzzy comparison.

Allowed paths: this page, product `functions/feeding.ts`, new synthetic tests and the immediately preceding directory-binding test fixture, product README and `pack.json`. Bump and sign the product pack. No earlier assertions are changed.
