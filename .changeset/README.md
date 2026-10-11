# Changesets

All ContextScope packages are versioned together (`fixed` group in `config.json`).
The Changesets CLI is not a dependency; run it on demand:

```sh
pnpm dlx @changesets/cli add       # describe your change (patch / minor / major)
pnpm dlx @changesets/cli version   # maintainers: bump versions + CHANGELOG
```

See the "Releasing" section of [CONTRIBUTING.md](../CONTRIBUTING.md).
