import { NextResponse } from "next/server";

const fallbackIceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
];

type CloudflareIceServersResponse = {
  iceServers?: RTCIceServer[];
};

function getSelfHostedIceServers() {
  const urls = process.env.TURN_URLS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;

  if (!urls?.length || !username || !credential) {
    return null;
  }

  return [
    ...fallbackIceServers,
    {
      urls,
      username,
      credential
    }
  ] satisfies RTCIceServer[];
}

function filterCloudflareIceServers(iceServers: RTCIceServer[]) {
  return iceServers.reduce<RTCIceServer[]>((filtered, server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const filteredUrls = urls.filter((url): url is string => Boolean(url) && !url.includes(":53"));

      if (filteredUrls.length > 0) {
        filtered.push({ ...server, urls: filteredUrls });
      }

      return filtered;
    }, []);
}

export async function GET() {
  const selfHostedIceServers = getSelfHostedIceServers();
  const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (selfHostedIceServers) {
    return NextResponse.json({ iceServers: selfHostedIceServers });
  }

  if (!turnKeyId || !turnApiToken) {
    return NextResponse.json({ iceServers: fallbackIceServers });
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${turnApiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ttl: 14400 }),
        cache: "no-store"
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        {
          error: "Could not generate Cloudflare TURN credentials.",
          details: text,
          iceServers: fallbackIceServers
        },
        { status: 502 }
      );
    }

    const data = await response.json() as CloudflareIceServersResponse;
    const iceServers = Array.isArray(data.iceServers)
      ? filterCloudflareIceServers(data.iceServers)
      : fallbackIceServers;

    return NextResponse.json({
      iceServers: iceServers.length > 0 ? iceServers : fallbackIceServers
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Cloudflare TURN request failed.",
        details: error instanceof Error ? error.message : "Unknown error",
        iceServers: fallbackIceServers
      },
      { status: 502 }
    );
  }
}
