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
