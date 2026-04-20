# Live Room

Two-person video, chat, screen share, and watch-together rooms built with Next.js, WebRTC, and Firebase Firestore signaling.

## Local setup

Install dependencies:

```bash
npm install
```

Create a Firebase web app, enable Firestore, then copy the example env file:

```bash
cp .env.local.example .env.local
```

Fill in the Firebase values:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

Optional for more reliable calls across different networks with self-hosted TURN:

```bash
TURN_URLS=turn:your-public-host:3478,turns:your-public-host:5349
TURN_USERNAME=
TURN_CREDENTIAL=
```

Or with Cloudflare TURN:

```bash
CLOUDFLARE_TURN_KEY_ID=
CLOUDFLARE_TURN_API_TOKEN=
```

Start the app:

```bash
npm run dev
```

## Firestore rules for a demo

These permissive rules are only for testing a demo quickly:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId}/signals/{signalId} {
      allow read, create: if true;
      allow update, delete: if false;
    }

    match /users/{username} {
      allow read, create, update: if true;
      allow delete: if false;

      match /calls/{callId} {
        allow read, create, update: if true;
        allow delete: if false;
      }
    }
  }
}
```

For production, add authentication, room membership checks, rate limits, and a cleanup job for old room signals.

## Vercel

Add the same `NEXT_PUBLIC_FIREBASE_*` values in Vercel Project Settings under Environment Variables, then deploy. Vercel provides HTTPS, which allows camera and microphone access in modern browsers.

For real device-to-device calls on different networks, add either self-hosted TURN server env vars (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`) or Cloudflare TURN server env vars (`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`) in Vercel. The app requests ICE servers from `/api/turn` at runtime. STUN-only WebRTC can fail or degrade when both peers are behind stricter NAT or firewall setups.

To create those Cloudflare values, create a TURN key in Cloudflare Realtime, then use the key ID plus an API token that can generate TURN credentials.

Screen sharing uses `getDisplayMedia()`. Desktop Chrome, Edge, Firefox, and modern desktop Safari can do this over HTTPS, but iPhone and iPad browsers may not support it.

## Self-hosted TURN on this Mac

`coturn` is installed through Homebrew, and this repo now includes:

- `turn/turnserver.conf`
- `scripts/start-turn.sh`

Start the TURN server locally:

```bash
./scripts/start-turn.sh
```

The current config uses:

```bash
TURN_URLS=turn:152.59.29.86:3478?transport=udp,turn:152.59.29.86:3478?transport=tcp
TURN_USERNAME=live-room
TURN_CREDENTIAL=e9f24821257925963895a331f70a7d75
```

Important: this Mac is currently on local IP `172.20.10.4`, which looks like a hotspot or upstream NAT network. In that setup, the TURN server may not be reachable from the public internet even if `coturn` is running. For outside access you usually need a normal router you control, plus port forwarding for:

- `3478` TCP/UDP
- `49160-49200` UDP

If your public or local IP changes, update `turn/turnserver.conf` before starting the server again.
