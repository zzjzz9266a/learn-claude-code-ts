This web app is the interactive learning frontend for `learn-claude-code`.

## Development

Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Build

Build the static export:

```bash
npm run build
```

This project uses `output: "export"` in `next.config.ts`, so the build output is written to `out/`.

## Preview

Preview the exported site locally:

```bash
npm run start
```

If port `3000` is already in use, the static server will choose another port automatically.

## Notes

- `npm run dev` uses Next.js dev mode.
- `npm run build` regenerates derived content first via `npm run extract`.
- `npm run start` serves the exported `out/` directory rather than launching a Next.js server.
