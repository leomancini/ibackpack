import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";

const Page = styled.div`
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
  cursor: none;
`;

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
  filter: ${(p) => (p.$paused ? "brightness(0)" : "none")};
  transition: filter 0.2s ease;
`;

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 32px 96px;
  color: #fff;
  font-family: "Playfair Display", "DejaVu Serif", "Liberation Serif", Georgia, serif;
  font-weight: 500;
  font-size: 48px;
  line-height: 1.3;
  text-align: center;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);
  pointer-events: none;
`;

const Message = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  color: #fff;
  font-size: 18px;
  padding: 24px;
  text-align: center;
`;

const PausedBadge = styled.div`
  position: absolute;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
`;

function useControlState() {
  const [state, setState] = useState({
    paused: false,
    homeConnected: false,
    loaded: false,
  });
  useEffect(() => {
    const es = new EventSource("/api/control/events");
    es.addEventListener("state", (e) => {
      try {
        const data = JSON.parse(e.data);
        setState({
          paused: !!data.paused,
          homeConnected: !!data.homeConnected,
          loaded: true,
        });
      } catch {}
    });
    return () => es.close();
  }, []);
  return state;
}

function useDescribe() {
  const [entry, setEntry] = useState(null);
  useEffect(() => {
    const es = new EventSource("/api/describe/events");
    es.addEventListener("describe", (e) => {
      try {
        setEntry(JSON.parse(e.data));
      } catch {}
    });
    return () => es.close();
  }, []);
  return entry;
}

function Home() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamCanvasRef = useRef(null);
  const pausedRef = useRef(false);
  const [error, setError] = useState(null);
  const [description, setDescription] = useState("");
  const { paused, loaded } = useControlState();

  useEffect(() => {
    const send = () => {
      fetch("/api/home/heartbeat", { method: "POST" }).catch(() => {});
    };
    send();
    const id = setInterval(send, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    if (!loaded) return;
    const video = videoRef.current;
    if (!video) return;
    if (paused) video.pause();
    else video.play().catch(() => {});
  }, [paused, loaded]);

  useEffect(() => {
    let stream;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      })
      .catch((err) => setError(err.message || "Unable to access camera"));

    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const capture = async () => {
      if (pausedRef.current) {
        timer = setTimeout(capture, 500);
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        timer = setTimeout(capture, 1000);
        return;
      }

      const w = 512;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 384;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);
      const image = canvas.toDataURL("image/jpeg", 0.5);

      try {
        const res = await fetch("/api/describe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image }),
        });
        const json = await res.json();
        if (!cancelled && json.description) {
          setDescription(json.description);
        }
      } catch (err) {
        // ignore transient errors
      }

      if (!cancelled) timer = setTimeout(capture, 1000);
    };

    timer = setTimeout(capture, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const push = async () => {
      if (pausedRef.current) {
        timer = setTimeout(push, 250);
        return;
      }
      const video = videoRef.current;
      const canvas = streamCanvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        timer = setTimeout(push, 500);
        return;
      }

      const w = 480;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);

      const blob = await new Promise((r) =>
        canvas.toBlob(r, "image/jpeg", 0.6)
      );
      if (blob) {
        try {
          await fetch("/api/stream/frame", {
            method: "POST",
            headers: { "Content-Type": "image/jpeg" },
            body: blob,
          });
        } catch {}
      }

      if (!cancelled) timer = setTimeout(push, 80);
    };

    timer = setTimeout(push, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <Page>
      <Video ref={videoRef} playsInline muted $paused={paused} />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <canvas ref={streamCanvasRef} style={{ display: "none" }} />
      {!paused && description && <Overlay>{description}</Overlay>}
      {error && <Message>{error}</Message>}
    </Page>
  );
}

const RemotePage = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  background: #111;
  color: #fff;
  font-family: system-ui, -apple-system, sans-serif;
  padding: 20px;
  box-sizing: border-box;
`;

const StreamFrame = styled.div`
  position: relative;
  width: min(90vw, 520px);
  aspect-ratio: 4 / 3;
  background: #000;
  border-radius: 24px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

const StreamImg = styled.img`
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
  filter: ${(p) => (p.$paused ? "brightness(0.3)" : "none")};
  transition: filter 0.2s ease;
`;

const PhotoRow = styled.div`
  width: min(90vw, 520px);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  flex-shrink: 0;
`;

const HaikuThumb = styled.img`
  width: 100%;
  height: auto;
  display: block;
  border-radius: 24px;
  transform: scaleX(-1);
  background: #000;
`;

const HaikuPlaceholder = styled.div`
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 24px;
  background: #000;
`;

const LocationCard = styled.div`
  flex: 1;
  min-width: 0;
  background: #1c1c1c;
  padding: 14px;
  border-radius: 24px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-sizing: border-box;

  @media (min-width: 768px) {
    justify-content: flex-start;
    gap: 12px;
  }
`;

const LocationLabel = styled.div`
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #888;
  margin-bottom: 6px;
`;

const LocationValue = styled.div`
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 18px;
  color: #eee;
  font-variant-numeric: tabular-nums;
`;

const ResponseCard = styled.div`
  width: min(90vw, 520px);
  flex: 1 1 0;
  min-height: 0;
  background: #1c1c1c;
  padding: 16px;
  border-radius: 24px;
  box-sizing: border-box;
  display: flex;
  overflow: hidden;
`;

const HaikuText = styled.div`
  flex: 1;
  overflow-y: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
  color: #eee;
  text-align: left;

  @media (min-width: 768px) {
    font-size: 19px;
  }
`;

const StatusDot = styled.div`
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${(p) =>
    p.$disconnected ? "#555" : p.$paused ? "#f59e0b" : "#22c55e"};
  box-shadow: ${(p) =>
    p.$disconnected
      ? "none"
      : `0 0 16px ${p.$paused ? "#f59e0b" : "#22c55e"}`};
`;

const StatusRow = styled.div`
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #fff;
`;

const ToggleButton = styled.button`
  width: min(90vw, 520px);
  height: 72px;
  border-radius: 24px;
  border: none;
  background: ${(p) => (p.$paused ? "#22c55e" : "#ef4444")};
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.08s ease, opacity 0.2s ease;
  &:active {
    transform: scale(0.98);
  }
  &:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
`;

const PlayIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);

function useGeolocation() {
  const [location, setLocation] = useState(null);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setLocation(loc);
        fetch("/api/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(loc),
        }).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 10000, timeout: 30000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return location;
}

function Remote() {
  const { paused, homeConnected } = useControlState();
  const describe = useDescribe();
  const location = useGeolocation();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy || !homeConnected) return;
    setBusy(true);
    try {
      await fetch("/api/control/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      });
    } finally {
      setBusy(false);
    }
  };

  let statusLabel;
  if (!homeConnected) statusLabel = "Not connected";
  else if (paused) statusLabel = "Paused";
  else statusLabel = "Live";

  return (
    <RemotePage>
      <StreamFrame>
        {homeConnected && (
          <StreamImg src="/api/stream.mjpeg" alt="Live feed" $paused={paused} />
        )}
        <StatusRow>
          <StatusDot $paused={paused} $disconnected={!homeConnected} />
          {statusLabel}
        </StatusRow>
      </StreamFrame>
      <PhotoRow>
        {describe?.image ? (
          <HaikuThumb src={describe.image} alt="" />
        ) : (
          <HaikuPlaceholder />
        )}
        <LocationCard>
          <div>
            <LocationLabel>Lat</LocationLabel>
            <LocationValue>
              {location ? location.lat.toFixed(5) : "—"}
            </LocationValue>
          </div>
          <div>
            <LocationLabel>Lng</LocationLabel>
            <LocationValue>
              {location ? location.lng.toFixed(5) : "—"}
            </LocationValue>
          </div>
        </LocationCard>
      </PhotoRow>
      <ResponseCard>
        <HaikuText>{describe?.description || ""}</HaikuText>
      </ResponseCard>
      <ToggleButton
        $paused={paused}
        onClick={toggle}
        disabled={!homeConnected}
        aria-label={paused ? "Play" : "Pause"}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </ToggleButton>
    </RemotePage>
  );
}

function App() {
  const isRemote =
    typeof window !== "undefined" &&
    window.location.pathname.startsWith("/remote");
  return isRemote ? <Remote /> : <Home />;
}

export default App;
