# UFC Live Dashboard

A React dashboard for following a UFC event in one place. It combines bout
status, round-by-round scoring, recent fighter form, sportsbook and prediction
market odds, and media scorecards.

The app currently runs entirely from local fixture data, so no API keys or
external services are required.

## Run the app

Requirements:

- Node.js
- npm

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view the dashboard.
Vite automatically reloads the page when source files change. Stop the server
with `Ctrl-C`.

## Keep it running with tmux

Create a named session and start the app:

```bash
tmux new -s ufcbuild
npm run dev
```

Detach without stopping the server by pressing `Ctrl-b`, then `d`. Reconnect
later with:

```bash
tmux attach -t ufcbuild
```

List existing sessions with `tmux ls`.

## Useful commands

```bash
npm run dev        # Start the local development server
npm test           # Run the test suite once
npm run typecheck  # Check TypeScript types
npm run build      # Create a production build
npm run preview    # Preview the production build locally
```

## Tech stack

- React 19
- TypeScript
- Vite
- Vitest
