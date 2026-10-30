# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Recalls in the United States from CPSC (consumer products), openFDA (food,
  drugs, medical devices) and NHTSA (vehicles by make, model and year, or by
  VIN decoded through vPIC): a device (recalls in 7 days, vehicle recall
  campaigns, latest recall), the `new_recall` scene trigger, the
  `read_recalls` scene action, the `recalls` widget and the `check_now`
  button.
- Each source read on its own schedule (3 to 24 h), one request at a time,
  with its own failures, pauses (429, 5xx) and copy under `/data`; a source
  that is not up to date is said, never counted as 0.
- VINs kept by Gladys as a secret field, sent only to NHTSA vPIC, never in
  the logs, the status nor `/data`.
