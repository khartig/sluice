# Releasing

sluice is published to npm as `sluice-relay`. The command it installs is
`sluice`. `.github/workflows/release.yml` publishes a version when a
GitHub Release is published, as Adhal's does.

## Once: the first version, and trusted publishing

npm lets a package trust a GitHub workflow only after the package
exists, so the first version is published by hand.

1. **Publish 0.1.0 from a clean checkout of its tag.**

   ```sh
   git checkout v0.1.0
   pnpm install --frozen-lockfile
   pnpm typecheck && pnpm test
   npm login
   pnpm publish --access public
   ```

   This version has no provenance attestation. Every version after it
   does.

2. **Make the repository's `npm` environment** (GitHub: Settings →
   Environments → New environment, named `npm`), and add yourself as a
   required reviewer. Then every publish waits for your approval.

3. **Add the trusted publisher on npm:** on npmjs.com, open the
   package's Settings → Trusted publishing → GitHub Actions, with:
   - organization or user: `khartig`
   - repository: `sluice`
   - workflow filename: `release.yml`
   - environment: `npm`

4. **Turn off token publishing** in the same settings ("Require two-factor
   authentication and disallow tokens"), so the workflow is the only way
   a version gets published.

## Each version

1. Bump `version` in `package.json` and commit it.
2. Make sure CI is green on that commit, both dependency scans included.
3. Tag it `v<version>` and push the tag.
4. Publish a GitHub Release for the tag. The release notes list any
   dependency exceptions in force (DEPENDENCY-POLICY.md).
5. Approve the `publish` job when it waits on the `npm` environment.

The job packs the tarball once, attests it, publishes it, checks that
npm serves exactly those bytes with a provenance attestation, and
attaches the tarball, `SHA256SUMS`, and a CycloneDX SBOM to the release.
To check a downloaded tarball:

```sh
gh attestation verify sluice-relay-<version>.tgz --repo khartig/sluice
```
