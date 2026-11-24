# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Migrated to NoFlo 2.x: `noflo`/`noflo-assembly`/`noflo-core` replaced by `@noflo/noflo`, `@noflo/assembly`, `@noflo/core` (2.0.0-alpha line)
- The package is now ESM (`"type": "module"`). The Signal K plugin entry is a default export, loaded by Signal K's `require()` of ESM (Node ≥ 20.19 / 22) or its `import()` fallback
- Component loading in scripts and tests goes through `@noflo/loader-node`'s registry; the multi-port assembly hook is renamed `handle()` → `processMessage()`; network events use EventTarget listeners; graph entities use definition-object APIs and frozen entities

### Fixed

- Duplicate `ReplyDispatcher SMTP -> ErrorLogger` edge in cloud-server.fbp — a latent bug that NoFlo 2.x graph loading rejects

### Removed

- `noflo-wrapper` dev dependency, replaced by a local test harness helper

## [0.4.0] - 2026-11-24

### Added

- Favicon and theme color for the webapp

### Changed

- Bumped reticulum-js dependencies for Reticulum 1.6 compatibility

## [0.3.3] - 2026-09-24

### Fixed

- Port names in NoFlo graphs

## [0.3.2] - 2026-09-21

### Changed

- Updated to the latest reticulum-js
- Enabled CI with lint and test fixes

## [0.3.1] - 2026-09-20

### Changed

- Bumped reticulum-js and dacar dependencies

## [0.3.0] - 2026-08-27

### Added

- Support for uploading GRIB files received via Winlink
- The webapp is served by Signal K and appears under the weather category
- Recommends `signalk-grib-weather-provider` as the GRIB source

### Changed

- Better UI styling, with a day/night mode fix
- Environment variable documentation updates

### Fixed

- Ping-pong flow, now covered by tests
- Metrics are actually counted
- Preview banner fitting, ACK ID casting, and field clearing on `fork`

## [0.2.2] - 2026-08-12

### Added

- A PING-PONG flow for connectivity testing
- All transmissions carry an ID, not just GRIB requests
- Part type identification and routing fields passed through

### Fixed

- Do not send NULL packets
- Part matching for blog posts
- ACK all message chunks, not just the last one
- Hi-fi data overwrites lo-fi via a "theirs" merge strategy
- Preview banner text fits

## [0.2.1] - 2026-08-12

### Changed

- Weather requests default to ECMWF

## [0.2.0] - 2026-08-12

### Added

- Winlink blog post encoding, in addition to InReach
- Image filenames are included in transmitted messages
- Post titles are encoded as a field

## [0.1.2] - 2026-08-12

### Fixed

- Webapp icon display

## [0.1.1] - 2026-08-12

### Added

- Device registration and listing scripts
- Screenshots for the Signal K plugin

### Fixed

- GRIBs are served with the correct MIME type
- Outport usage in components

### Changed

- More readable buttons

## [0.1.0] - 2026-08-12

### Added

- Initial release: Signal K plugin for encoding blog posts and weather requests for transmission via InReach
- Cloud server receiving InReach messages, with ACK handling, error alerting, and Dacar grant checking
- Target-aware GRIB weather requests via Saildocs, decoded server-side and served to the webapp
- End-to-end ping-pong messaging with InReach devices
- Webapp for composing blog posts and requesting weather
