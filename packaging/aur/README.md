# AUR packaging

This directory maintains the [`ompanel-bin`](https://aur.archlinux.org/packages/ompanel-bin) and
[`ompanel-nightly-bin`](https://aur.archlinux.org/packages/ompanel-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

Neither package is on the AUR yet. The `pkgver` and checksums in the PKGBUILDs are placeholders
carried over from upstream; the first publish run replaces them with the values of a real
`TurtleByte-IN/ompanel` release.

## Publishing

The release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub release;
the workflow can also be run manually for a specific tag. It selects the stable or nightly
package, then updates its version and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
