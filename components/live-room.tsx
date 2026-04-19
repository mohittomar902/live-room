"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase";

type SignalMessage = {
  id: string;
  type: "join" | "offer" | "answer" | "ice" | "leave";
  from: string;
  to?: string;
  data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

type ChatMessage = {
  id: string;
  sender: "You" | "Peer";
  text: string;
  at: string;
};

type DataMessage =
  | { kind: "chat"; text: string; at: string }
  | { kind: "media"; action: "play" | "pause" | "seek" | "load-url"; time?: number; url?: string }
  | { kind: "screen-state"; active: boolean };

type CallRequest = {
  id: string;
  callerUsername: string;
  callerUserId: string;
  targetUsername: string;
  roomId: string;
  status: "ringing" | "accepted" | "declined" | "cancelled";
};

const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

const cameraConstraints: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
};

const screenConstraints: DisplayMediaStreamOptions = {
  video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 15, max: 30 } },
  audio: true
};

function createId() {
  return Math.random().toString(36).slice(2, 9);
}

function createRoomName() {
  const words = ["orbit", "cinema", "signal", "studio", "lounge", "duo"];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function getMediaErrorMessage(error: unknown) {
  if (!window.isSecureContext) {
    return "Camera and microphone need HTTPS on another device. Use localhost on this computer or open the app through an HTTPS tunnel.";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support camera and microphone access here.";
  }

  if (error instanceof DOMException) {
    if (error.name === "NotSupportedError") {
      return "This browser does not support camera and microphone access here.";
    }

    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Camera or microphone permission was denied. Allow access in the browser site settings, then join again.";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No camera or microphone was found on this device.";
    }

    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "Your camera or microphone is already in use by another app.";
    }

    return `Camera or microphone could not be opened. Browser error: ${error.name}.`;
  }

  return "Camera or microphone could not be opened.";
}

function getSignalErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const code = "code" in error ? String(error.code) : "";
    const message = "message" in error ? String(error.message) : "";

    if (code.includes("permission-denied") || message.includes("permission")) {
      return "Firebase blocked the room signal. Check your Firestore rules for rooms/{roomId}/signals/{signalId}.";
    }

    if (code.includes("unavailable") || message.includes("network")) {
      return "Firebase signaling is unreachable. Check your internet connection and Firebase project config.";
    }

    if (message) {
      return `Could not join the room. Firebase error: ${message}`;
    }
  }

  return "Could not join the room. Check Firebase setup and Firestore rules.";
}

export function LiveRoom() {
  const [userId, setUserId] = useState("");
  const [entryMode, setEntryMode] = useState<"guest" | "username">("guest");
  const [displayName, setDisplayName] = useState("Guest");
  const [loginName, setLoginName] = useState("");
  const [loggedInUsername, setLoggedInUsername] = useState("");
  const [callTarget, setCallTarget] = useState("");
  const [incomingCall, setIncomingCall] = useState<CallRequest | null>(null);
  const [outgoingCall, setOutgoingCall] = useState<CallRequest | null>(null);
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [status, setStatus] = useState("Create or join a room to begin.");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [peerScreenOn, setPeerScreenOn] = useState(false);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const [spotlight, setSpotlight] = useState<"peer" | "self">("peer");
  const [mediaUrl, setMediaUrl] = useState("");

  const stageRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const watchVideoRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const queuedIceRef = useRef<RTCIceCandidateInit[]>([]);
  const seenSignalIdsRef = useRef(new Set<string>());
  const unsubscribeSignalsRef = useRef<Unsubscribe | null>(null);
  const applyingRemoteMediaRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const screenSenderRef = useRef<RTCRtpSender | null>(null);
  const screenTransceiverRef = useRef<RTCRtpTransceiver | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerScreenStreamRef = useRef<MediaStream | null>(null);
  const trimmedRoomId = useMemo(() => roomId.trim().toLowerCase(), [roomId]);

  useEffect(() => {
    setUserId(createId());
    setRoomId(createRoomName());
  }, []);

  useEffect(() => {
    return () => {
      closeCall("leave");
    };
  }, []);

  useEffect(() => {
    const big = remoteVideoRef.current;
    const small = localVideoRef.current;
    if (!big || !small) return;

    if (screenOn) {
      // Local user is screen sharing: big = own screen, small = peer camera
      big.srcObject = screenStreamRef.current;
      small.srcObject = remoteStreamRef.current;
    } else if (peerScreenOn) {
      // Peer is screen sharing: big = peer screen, small = peer camera
      big.srcObject = peerScreenStreamRef.current;
      small.srcObject = remoteStreamRef.current;
    } else {
      // Normal call: big = peer camera, small = own camera
      big.srcObject = remoteStreamRef.current;
      small.srcObject = localStreamRef.current;
    }
  }, [screenOn, peerScreenOn]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setStageFullscreen(document.fullscreenElement === stageRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!loggedInUsername || !db) {
      return;
    }

    const callsQuery = query(
      collection(db, "users", loggedInUsername, "calls"),
      orderBy("createdAt", "desc"),
      limit(10)
    );

    const unsubscribe = onSnapshot(
      callsQuery,
      (snapshot) => {
        const ringingCall = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }) as CallRequest)
          .find((call) => call.status === "ringing" && call.callerUserId !== userId);

        setIncomingCall(ringingCall ?? null);

        if (ringingCall && !joined) {
          startRingtone();
        } else {
          stopRingtone();
        }
      },
      (error) => {
        setStatus(getSignalErrorMessage(error));
      }
    );

    return () => {
      unsubscribe();
      stopRingtone();
    };
  }, [joined, loggedInUsername, userId]);

  useEffect(() => {
    if (!outgoingCall || !db) {
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, "users", outgoingCall.targetUsername, "calls", outgoingCall.id),
      (snapshot) => {
        if (!snapshot.exists()) {
          return;
        }

        const call = { id: snapshot.id, ...snapshot.data() } as CallRequest;

        if (call.status === "accepted") {
          setOutgoingCall(null);
          setRoomId(call.roomId);
          startJoin(call.roomId).catch((error) => {
            setStatus(getSignalErrorMessage(error));
          });
        }

        if (call.status === "declined") {
          setOutgoingCall(null);
          setStatus(`${call.targetUsername} declined the call.`);
        }

        if (call.status === "cancelled") {
          setOutgoingCall(null);
          setStatus("Call cancelled.");
        }
      },
      (error) => {
        setStatus(getSignalErrorMessage(error));
      }
    );

    return () => {
      unsubscribe();
    };
  }, [outgoingCall]);

  useEffect(() => {
    if (!joined || !db || !trimmedRoomId) {
      return;
    }

    const signalsQuery = query(
      collection(db, "rooms", trimmedRoomId, "signals"),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(
      signalsQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type !== "added" || seenSignalIdsRef.current.has(change.doc.id)) {
            return;
          }

          seenSignalIdsRef.current.add(change.doc.id);
          const signal = { id: change.doc.id, ...change.doc.data() } as SignalMessage;

          if (signal.from === userId || (signal.to && signal.to !== userId)) {
            return;
          }

          handleSignal(signal).catch(() => {
            setStatus("Could not process the latest room signal.");
          });
        });
      },
      (error) => {
        setStatus(getSignalErrorMessage(error));
      }
    );

    unsubscribeSignalsRef.current = unsubscribe;

    return () => {
      unsubscribe();
      if (unsubscribeSignalsRef.current === unsubscribe) {
        unsubscribeSignalsRef.current = null;
      }
    };
  }, [joined, trimmedRoomId, userId]);

  async function postSignal(
    type: SignalMessage["type"],
    data?: SignalMessage["data"],
    to?: string,
    roomOverride?: string
  ) {
    const signalRoomId = roomOverride ?? trimmedRoomId;

    if (!db || !signalRoomId) {
      throw new Error("Firebase is not configured.");
    }

    await addDoc(collection(db, "rooms", signalRoomId, "signals"), {
      type,
      from: userId,
      to: to ?? null,
      data: data ?? null,
      createdAt: serverTimestamp()
    });
  }

  async function ensureLocalStream() {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("Media devices unavailable", "NotSupportedError");
    }

    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    stream.getVideoTracks().forEach((t) => { t.contentHint = "motion"; });
    localStreamRef.current = stream;
    setCameraOn(stream.getVideoTracks().some((track) => track.enabled));
    setMicOn(stream.getAudioTracks().some((track) => track.enabled));

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    return stream;
  }

  function initRingtone() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    audioContextRef.current.resume().catch(() => undefined);
  }

  function startRingtone() {
    initRingtone();

    if (ringTimerRef.current || !audioContextRef.current) {
      return;
    }

    const playBeep = () => {
      const context = audioContextRef.current;
      if (!context) {
        return;
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.6);
    };

    playBeep();
    ringTimerRef.current = window.setInterval(playBeep, 1400);
  }

  function stopRingtone() {
    if (ringTimerRef.current) {
      window.clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }

  async function createConnection(remoteId: string) {
    if (connectionRef.current) {
      return connectionRef.current;
    }

    const connection = new RTCPeerConnection(iceServers);
    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        postSignal("ice", event.candidate.toJSON(), remoteId).catch(() => {
          setStatus("Could not send a network candidate.");
        });
      }
    };

    connection.ontrack = (event) => {
      if (event.transceiver === screenTransceiverRef.current) {
        // Peer's screen share track
        const s = event.streams[0] ?? new MediaStream();
        peerScreenStreamRef.current = s;
        if (!event.streams[0]) event.track.onunmute = () => s.addTrack(event.track);
      } else {
        // Peer's camera + audio track
        const stream = event.streams[0];
        if (stream) {
          remoteStreamRef.current = stream;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
        } else {
          event.track.onunmute = () => remoteStream.addTrack(event.track);
        }
        setStatus("Connected. You are live.");
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        setStatus("Connected. You are live.");
        const vSender = videoSenderRef.current;
        if (vSender) {
          const params = vSender.getParameters();
          if (params.encodings?.length) {
            params.encodings[0].maxBitrate = 2_500_000;
            vSender.setParameters(params).catch(() => undefined);
          }
        }
      }
      if (state === "disconnected" || state === "failed") {
        setStatus("Peer disconnected. You can wait or rejoin.");
      }
    };

    connection.ondatachannel = (event) => {
      wireDataChannel(event.channel);
    };

    const stream = await ensureLocalStream();
    stream.getTracks().forEach((track) => {
      const sender = connection.addTrack(track, stream);
      if (track.kind === "video") videoSenderRef.current = sender;
    });
    const screenTransceiver = connection.addTransceiver("video", { direction: "sendrecv" });
    screenSenderRef.current = screenTransceiver.sender;
    screenTransceiverRef.current = screenTransceiver;
    connectionRef.current = connection;
    return connection;
  }

  function wireDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;

    channel.onopen = () => {
      setStatus("Chat and watch sync are ready.");
    };

    channel.onmessage = (event) => {
      const data = JSON.parse(event.data) as DataMessage;

      if (data.kind === "chat") {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), sender: "Peer", text: data.text, at: data.at }
        ]);
      }

      if (data.kind === "media") {
        applyRemoteMedia(data);
      }

      if (data.kind === "screen-state") {
        setPeerScreenOn(data.active);
      }
    };
  }

  async function handleSignal(message: SignalMessage) {
    if (message.type === "join") {
      setPeerId(message.from);
      setStatus("Peer found. Preparing the call...");

      if (userId > message.from) {
        await startOffer(message.from);
      }
    }

    if (message.type === "offer") {
      setPeerId(message.from);
      const connection = await createConnection(message.from);
      await connection.setRemoteDescription(message.data as RTCSessionDescriptionInit);
      await flushQueuedIce(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await postSignal("answer", answer, message.from);
      setStatus("Answer sent. Connecting media...");
    }

    if (message.type === "answer" && connectionRef.current) {
      await connectionRef.current.setRemoteDescription(message.data as RTCSessionDescriptionInit);
      await flushQueuedIce(connectionRef.current);
      setStatus("Answer received. Connecting media...");
    }

    if (message.type === "ice") {
      const candidate = message.data as RTCIceCandidateInit;
      const connection = connectionRef.current;

      if (!connection?.remoteDescription) {
        queuedIceRef.current.push(candidate);
        return;
      }

      await connection.addIceCandidate(candidate);
    }

    if (message.type === "leave") {
      setStatus("Peer left the room.");
      setPeerId("");
    }
  }

  async function flushQueuedIce(connection: RTCPeerConnection) {
    for (const candidate of queuedIceRef.current) {
      await connection.addIceCandidate(candidate);
    }
    queuedIceRef.current = [];
  }

  async function startOffer(remoteId: string) {
    const connection = await createConnection(remoteId);

    if (!dataChannelRef.current) {
      wireDataChannel(connection.createDataChannel("room-events"));
    }

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await postSignal("offer", offer, remoteId);
    setStatus("Offer sent. Waiting for answer...");
  }

  async function startJoin(roomToJoin = trimmedRoomId) {
    if (!roomToJoin.trim()) {
      setStatus("Add a room code first.");
      return;
    }

    if (!userId) {
      setStatus("Room is still preparing. Try again in a moment.");
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setStatus("Add your Firebase environment variables before joining a room.");
      return;
    }

    try {
      await ensureLocalStream();
    } catch (error) {
      setJoined(false);
      setStatus(getMediaErrorMessage(error));
      return;
    }

    try {
      seenSignalIdsRef.current = new Set<string>();
      await postSignal("join", undefined, undefined, roomToJoin);
      setJoined(true);
      setStatus("Room joined. Waiting for the second user...");
    } catch (error) {
      closeCall();
      setJoined(false);
      setStatus(getSignalErrorMessage(error));
    }
  }

  async function joinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await startJoin();
  }

  async function loginWithUsername(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = normalizeUsername(loginName);

    if (!username) {
      setStatus("Enter a username using letters, numbers, underscore, or hyphen.");
      return;
    }

    if (!userId) {
      setStatus("Login is still preparing. Try again in a moment.");
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setStatus("Add your Firebase environment variables before logging in.");
      return;
    }

    try {
      initRingtone();
      await setDoc(
        doc(db, "users", username),
        {
          username,
          userId,
          displayName: username,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      setLoggedInUsername(username);
      setDisplayName(username);
      setLoginName(username);
      setStatus(`Logged in as ${username}. You can receive calls now.`);
    } catch (error) {
      setStatus(getSignalErrorMessage(error));
    }
  }

  async function callUsername(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetUsername = normalizeUsername(callTarget);

    if (!loggedInUsername) {
      setStatus("Login with your username before calling someone.");
      return;
    }

    if (!targetUsername) {
      setStatus("Enter the username you want to call.");
      return;
    }

    if (targetUsername === loggedInUsername) {
      setStatus("You cannot call your own username.");
      return;
    }

    if (!db) {
      setStatus("Firebase is not configured.");
      return;
    }

    try {
      const roomForCall = createRoomName();
      const callRef = doc(collection(db, "users", targetUsername, "calls"));
      const call: CallRequest = {
        id: callRef.id,
        callerUsername: loggedInUsername,
        callerUserId: userId,
        targetUsername,
        roomId: roomForCall,
        status: "ringing"
      };

      await setDoc(callRef, {
        ...call,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      setOutgoingCall(call);
      setStatus(`Calling ${targetUsername}...`);
    } catch (error) {
      setStatus(getSignalErrorMessage(error));
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !db) {
      return;
    }

    try {
      stopRingtone();
      await updateDoc(doc(db, "users", loggedInUsername, "calls", incomingCall.id), {
        status: "accepted",
        updatedAt: serverTimestamp()
      });
      setRoomId(incomingCall.roomId);
      setIncomingCall(null);
      await startJoin(incomingCall.roomId);
    } catch (error) {
      setStatus(getSignalErrorMessage(error));
    }
  }

  async function declineIncomingCall() {
    if (!incomingCall || !db) {
      return;
    }

    try {
      stopRingtone();
      await updateDoc(doc(db, "users", loggedInUsername, "calls", incomingCall.id), {
        status: "declined",
        updatedAt: serverTimestamp()
      });
      setIncomingCall(null);
      setStatus("Call declined.");
    } catch (error) {
      setStatus(getSignalErrorMessage(error));
    }
  }

  async function cancelOutgoingCall() {
    if (!outgoingCall || !db) {
      return;
    }

    try {
      await updateDoc(doc(db, "users", outgoingCall.targetUsername, "calls", outgoingCall.id), {
        status: "cancelled",
        updatedAt: serverTimestamp()
      });
      setOutgoingCall(null);
      setStatus("Call cancelled.");
    } catch (error) {
      setStatus(getSignalErrorMessage(error));
    }
  }

  function closeCall(reason?: SignalMessage["type"]) {
    stopRingtone();

    if (reason === "leave" && joined) {
      postSignal("leave", undefined, peerId || undefined).catch(() => undefined);
    }

    dataChannelRef.current?.close();
    connectionRef.current?.close();
    unsubscribeSignalsRef.current?.();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());

    dataChannelRef.current = null;
    connectionRef.current = null;
    videoSenderRef.current = null;
    screenSenderRef.current = null;
    screenTransceiverRef.current = null;
    screenStreamRef.current = null;
    peerScreenStreamRef.current = null;
    unsubscribeSignalsRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    queuedIceRef.current = [];
  }

  function leaveRoom() {
    closeCall("leave");
    setJoined(false);
    setPeerId("");
    setPeerScreenOn(false);
    setScreenOn(false);
    setOutgoingCall(null);
    setStatus("You left the room.");
  }

  function sendData(data: DataMessage) {
    const channel = dataChannelRef.current;

    if (!channel || channel.readyState !== "open") {
      setStatus("Peer channel is not ready yet.");
      return false;
    }

    channel.send(JSON.stringify(data));
    return true;
  }

  function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatText.trim();

    if (!text) {
      return;
    }

    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sent = sendData({ kind: "chat", text: `${displayName}: ${text}`, at });

    if (sent) {
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), sender: "You", text, at }
      ]);
      setChatText("");
    }
  }

  function toggleMic() {
    const audio = localStreamRef.current?.getAudioTracks()[0];
    if (audio) {
      audio.enabled = !audio.enabled;
      setMicOn(audio.enabled);
    }
  }

  async function toggleCamera() {
    if (cameraOn) {
      // Release from sender BEFORE stopping the track.
      await videoSenderRef.current?.replaceTrack(null);
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        localStreamRef.current?.removeTrack(videoTrack);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      setCameraOn(false);
    } else {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        });
        const newTrack = newStream.getVideoTracks()[0];
        newTrack.contentHint = "motion";
        localStreamRef.current?.addTrack(newTrack);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current ?? null;
        }
        await videoSenderRef.current?.replaceTrack(newTrack);
        setCameraOn(true);
      } catch (error) {
        setStatus(getMediaErrorMessage(error));
      }
    }
  }

  async function toggleScreenShare() {
    if (!connectionRef.current || !screenSenderRef.current) {
      setStatus("Start the call before sharing your screen.");
      return;
    }

    if (screenOn) {
      screenStreamRef.current = null;
      await screenSenderRef.current.replaceTrack(null);
      sendData({ kind: "screen-state", active: false });
      setScreenOn(false);
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia(screenConstraints);
      const screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.contentHint = "detail";
      await screenSenderRef.current.replaceTrack(screenTrack);

      screenStreamRef.current = new MediaStream([screenTrack]);
      sendData({ kind: "screen-state", active: true });

      screenTrack.onended = async () => {
        screenStreamRef.current = null;
        await screenSenderRef.current?.replaceTrack(null);
        sendData({ kind: "screen-state", active: false });
        setScreenOn(false);
      };

      setScreenOn(true);
    } catch {
      setStatus("Screen sharing was cancelled.");
    }
  }

  async function toggleStageFullscreen() {
    const stage = stageRef.current;

    if (!stage || !document.fullscreenEnabled) {
      setStatus("Fullscreen is not available in this browser.");
      return;
    }

    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch {
      setStatus("Fullscreen mode could not be opened.");
    }
  }

  function loadSharedUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = mediaUrl.trim();

    if (!url || !watchVideoRef.current) {
      return;
    }

    watchVideoRef.current.src = url;
    watchVideoRef.current.load();
    sendData({ kind: "media", action: "load-url", url });
  }

  function loadLocalFile(file?: File) {
    if (!file || !watchVideoRef.current) {
      return;
    }

    watchVideoRef.current.src = URL.createObjectURL(file);
    setStatus("Local file loaded. Ask your peer to load the same movie file, then sync playback.");
  }

  function broadcastMedia(action: "play" | "pause" | "seek") {
    if (applyingRemoteMediaRef.current || !watchVideoRef.current) {
      return;
    }

    sendData({ kind: "media", action, time: watchVideoRef.current.currentTime });
  }

  async function applyRemoteMedia(data: Extract<DataMessage, { kind: "media" }>) {
    const player = watchVideoRef.current;
    if (!player) {
      return;
    }

    applyingRemoteMediaRef.current = true;

    if (data.action === "load-url" && data.url) {
      setMediaUrl(data.url);
      player.src = data.url;
      player.load();
      window.setTimeout(() => { applyingRemoteMediaRef.current = false; }, 250);
      return;
    }

    if (typeof data.time === "number" && Math.abs(player.currentTime - data.time) > 1) {
      player.currentTime = data.time;
    }

    if (data.action === "play") {
      if (player.readyState < 3) {
        await new Promise<void>((resolve) => {
          player.addEventListener("canplay", () => resolve(), { once: true });
          window.setTimeout(resolve, 5000);
        });
      }
      await player.play().catch(() => undefined);
    }

    if (data.action === "pause") {
      player.pause();
    }

    window.setTimeout(() => {
      applyingRemoteMediaRef.current = false;
    }, 250);
  }

  return (
    <main className="room-shell">
      <section className="topbar" aria-label="Room controls">
        <div>
          <p className="eyebrow">Live Room</p>
          <h1>Video, chat, screen share, and movie sync for two.</h1>
        </div>
        <div className="status-pill">{status}</div>
      </section>

      <section className="join-band">
        <div className="role-switch" aria-label="Join mode">
          <button
            type="button"
            className={entryMode === "guest" ? "active-role" : ""}
            onClick={() => setEntryMode("guest")}
          >
            Guest room
          </button>
          <button
            type="button"
            className={entryMode === "username" ? "active-role" : ""}
            onClick={() => setEntryMode("username")}
          >
            Username call
          </button>
        </div>

        {entryMode === "guest" ? (
          <>
            <form className="join-form" onSubmit={joinRoom}>
              <label>
                Your name
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={joined}
                  maxLength={28}
                />
              </label>
              <label>
                Room code
                <input
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                  disabled={joined}
                  maxLength={36}
                />
              </label>
              {!joined ? (
                <button type="submit" disabled={!userId}>
                  Join room
                </button>
              ) : (
                <button type="button" onClick={leaveRoom}>
                  Leave room
                </button>
              )}
            </form>
            <p>
              Share this room code with one other person: <strong>{roomId}</strong>
            </p>
          </>
        ) : (
          <div className="username-panel">
            <form className="username-form" onSubmit={loginWithUsername}>
              <label>
                Your username
                <input
                  value={loginName}
                  onChange={(event) => setLoginName(normalizeUsername(event.target.value))}
                  disabled={joined}
                  placeholder="alex"
                  maxLength={32}
                />
              </label>
              <button type="submit" disabled={!userId || joined}>
                {loggedInUsername ? "Update login" : "Login"}
              </button>
            </form>

            <form className="username-form" onSubmit={callUsername}>
              <label>
                Call username
                <input
                  value={callTarget}
                  onChange={(event) => setCallTarget(normalizeUsername(event.target.value))}
                  disabled={!loggedInUsername || joined || Boolean(outgoingCall)}
                  placeholder="friend_username"
                  maxLength={32}
                />
              </label>
              {!outgoingCall ? (
                <button type="submit" disabled={!loggedInUsername || joined}>
                  Call user
                </button>
              ) : (
                <button type="button" onClick={cancelOutgoingCall}>
                  Cancel call
                </button>
              )}
            </form>

            <p>
              {loggedInUsername ? (
                <>
                  Logged in as <strong>{loggedInUsername}</strong>. Ask someone to call this username.
                </>
              ) : (
                "Login with a username to receive calls and call another username."
              )}
            </p>
          </div>
        )}
      </section>

      {incomingCall && !joined && (
        <section className="incoming-call" aria-live="assertive">
          <div>
            <p className="eyebrow">Incoming Call</p>
            <h2>{incomingCall.callerUsername} wants to join a video call.</h2>
          </div>
          <div className="incoming-actions">
            <button type="button" onClick={acceptIncomingCall}>
              Accept
            </button>
            <button type="button" onClick={declineIncomingCall}>
              Decline
            </button>
          </div>
        </section>
      )}

      <section className="stage-grid">
        <div className={`video-stage spotlight-${spotlight}`} ref={stageRef}>
          <div className="remote-frame">
            <video ref={remoteVideoRef} autoPlay playsInline />
            {!peerId && <span>Waiting for your peer</span>}
            {peerId && spotlight === "peer" && (
              <strong className="stage-label">
                {screenOn ? "Your screen" : peerScreenOn ? "Peer screen" : "Peer video"}
              </strong>
            )}
          </div>
          <div className="self-frame">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span>{screenOn || peerScreenOn ? "Peer camera" : `${displayName || "You"} camera`}</span>
          </div>
          <div className="call-controls">
            <button onClick={toggleMic} disabled={!joined}>
              {micOn ? "Mute mic" : "Unmute mic"}
            </button>
            <button onClick={toggleCamera} disabled={!joined}>
              {cameraOn ? "Stop camera" : "Start camera"}
            </button>
            <button onClick={toggleScreenShare} disabled={!joined}>
              {screenOn ? "Stop sharing" : "Share screen"}
            </button>
            <button onClick={() => setSpotlight((current) => (current === "peer" ? "self" : "peer"))} type="button">
              Switch view
            </button>
            <button onClick={toggleStageFullscreen} type="button">
              {stageFullscreen ? "Exit full screen" : "Full screen"}
            </button>
          </div>
        </div>

        <aside className="chat-panel">
          <div className="panel-heading">
            <p className="eyebrow">Chat</p>
            <strong>{peerId ? "Peer online" : "No peer yet"}</strong>
          </div>
          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <p className="empty-copy">Messages will appear here once the data channel opens.</p>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={message.sender === "You" ? "own-message" : ""}>
                  <span>{message.sender}</span>
                  <p>{message.text}</p>
                  <time>{message.at}</time>
                </article>
              ))
            )}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <input
              value={chatText}
              onChange={(event) => setChatText(event.target.value)}
              placeholder="Type a message"
              maxLength={400}
            />
            <button type="submit">Send</button>
          </form>
        </aside>
      </section>

      <section className="watch-room">
        <div className="watch-copy">
          <p className="eyebrow">Watch Together</p>
          <h2>Load one video, then play, pause, and seek in sync.</h2>
          <p>
            Use a direct MP4/WebM link, or have both users pick the same local movie file and let
            the player controls keep time together.
          </p>
        </div>

        <div className="watch-player">
          <video
            ref={watchVideoRef}
            controls
            playsInline
            onPlay={() => broadcastMedia("play")}
            onPause={() => broadcastMedia("pause")}
            onSeeked={() => broadcastMedia("seek")}
          />
        </div>

        <div className="watch-controls">
          <form onSubmit={loadSharedUrl}>
            <input
              type="url"
              value={mediaUrl}
              onChange={(event) => setMediaUrl(event.target.value)}
              placeholder="https://example.com/movie.mp4"
            />
            <button type="submit">Load URL</button>
          </form>
          <label className="file-loader">
            Pick local video
            <input type="file" accept="video/*" onChange={(event) => loadLocalFile(event.target.files?.[0])} />
          </label>
        </div>
      </section>
    </main>
  );
}
