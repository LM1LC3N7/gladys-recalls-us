# gladys-recalls-us

Recalls in the United States for [Gladys Assistant](https://gladysassistant.com),
read from the public data of three agencies: consumer products (CPSC), food,
drugs and medical devices (openFDA enforcement reports), and the recall
campaigns of your vehicles (NHTSA, by make, model and year, or by VIN): a
device (recalls in 7 days, vehicle recall campaigns, latest recall), a scene
trigger for each new recall of your selection, a scene action and a dashboard
widget. English and French texts.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Tested against the real services on 30/10/2026 and on fake servers built
  from their answers; not yet over weeks of real use nor with a real Gladys.
- Requires Gladys 5.1.0 or later. No account, no key. A VIN is sent only to
  NHTSA (vPIC) and never written in the logs, the status or `/data`.

## Development

```bash
npm install
npm test               # node --test, against the SDK's fake Gladys and fake CPSC, openFDA and NHTSA servers
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
```

See `CLAUDE.md` for the architecture and the rules.

## Licence

Apache License 2.0 (`LICENSE`); third-party notices in `THIRD_PARTY_NOTICES.md`.
Not affiliated with CPSC, the FDA, NHTSA nor any US agency.
