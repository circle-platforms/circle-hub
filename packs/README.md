# Product-line installation

`CIRCLE_SERVER_PRODUCT_LINES` selects a runtime JSON installation file. When unset, the server uses [installed-product-lines.json](installed-product-lines.json), which installs the APV and fictional Meridian manifests. Source addresses and credentials remain in separate runtime configuration.

```json
{
  "schemaVersion": "installed-product-lines/1",
  "productLines": ["apv/product-line.json", "meridian/product-line.json"]
}
```

Manifest paths resolve relative to the installation file, including when supplied outside this repository. Each manifest follows `product-line/1`: `id`, `version`, `connectorPackages`, optional `toolAliases`, `skills`, `methods`, `knowledgeMappings`, `configuration` and `synthetic`. Connector bindings may be package IDs or `{ "packageId": "documents", "alias": "meridian_docs" }`; the two existing forms are supported. IDs must be unique across installed lines, connector packages must exist in the installed implementation library, and skill/method paths must be relative to the product directory. Conflicting alias declarations and unsupported schema versions fail startup.

Register a connector asset with `configuration.productLineId` to select that line's declared tool prefix. Explicit `configuration.alias` continues to select an instance alias. Without a product-line ID, the first manifest declaring a connector supplies its default prefix, preserving the original APV client names. Tool names remain unique within the tenant and collisions are rejected during asset registration. Removing a line hides its explicitly bound tools on restart; restoring it makes the same approved bindings available again. Shared knowledge tools remain installed when the list is empty. Source profiles, credentials and current grants are checked through the ordinary tool path.

The loader reads declarations rather than importing executable modules from manifest paths. Skills still go through upload, digest-bound approval and run admission; merely listing a skill grants no execution or source access. Knowledge mappings and method paths stay with their product line. Existing installed professional implementations and historical migrations keep the phase-one compilation API compatible. A new product line using the existing connectors and governed skill runtime needs only its manifest, files and installation configuration.

`synthetic/readonly-sources.ts` owns fictional source data used by `dev:stack` and acceptance fixtures. Connector implementations contain only reusable transport, parsing and projection behavior.
