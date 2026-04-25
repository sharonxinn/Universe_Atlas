# Universe 3D Viewer

A full-stack app that renders an interactive 3D solar-system style universe and fetches live planet information from API Ninjas.

## Features

- 3D universe scene built with Three.js
- Orbiting planets animation with camera controls
- Backend proxy endpoint for secure API key usage
- Planet list panel with live API data

## Quick Start

1. Install dependencies:

   npm install

2. Create `.env` from `.env.example` and set your key:

   API_NINJAS_KEY=your_key_here

3. Run app:

   npm start

4. Open:

   http://localhost:3000

## API Route

- `GET /api/planets` fetches all available planets from API Ninjas and returns JSON.
