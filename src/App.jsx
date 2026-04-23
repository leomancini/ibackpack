import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";

const Page = styled.div`
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
`;

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
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
  const [state, setState] = useState({ paused: false, loaded: false });
  useEffect(() => {
    const es = new EventSource("/api/control/events");
    es.addEventListener("state", (e) => {
      try {
        const data = JSON.parse(e.data);
        setState({ paused: !!data.paused, loaded: true });
      } catch {}
    });
    return () => es.close();
  }, []);
  return state;
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

      const w = 320;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 240;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);
      const image = canvas.toDataURL("image/jpeg", 0.5);

      try {
        await fetch("/api/stream/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image }),
        });
      } catch {}

      if (!cancelled) timer = setTimeout(push, 166);
    };

    timer = setTimeout(push, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <Page>
      <Video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <canvas ref={streamCanvasRef} style={{ display: "none" }} />
      {description && <Overlay>{description}</Overlay>}
      {paused && <PausedBadge>Paused</PausedBadge>}
      {error && <Message>{error}</Message>}
    </Page>
  );
}

const RemotePage = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 20px;
  background: #111;
  color: #fff;
  font-family: system-ui, -apple-system, sans-serif;
  padding: 24px;
`;

const StreamFrame = styled.div`
  width: min(90vw, 520px);
  aspect-ratio: 4 / 3;
  background: #000;
  border-radius: 16px;
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
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
`;

const StatusDot = styled.div`
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${(p) => (p.$paused ? "#f59e0b" : "#22c55e")};
  box-shadow: 0 0 16px ${(p) => (p.$paused ? "#f59e0b" : "#22c55e")};
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #aaa;
`;

const ToggleButton = styled.button`
  width: min(80vw, 280px);
  height: min(80vw, 280px);
  border-radius: 50%;
  border: none;
  background: ${(p) => (p.$paused ? "#22c55e" : "#f59e0b")};
  color: #000;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 0.08s ease;
  &:active {
    transform: scale(0.96);
  }
`;

function useStreamFrame() {
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    const es = new EventSource("/api/stream/events");
    es.addEventListener("frame", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.image) setFrame(data.image);
      } catch {}
    });
    return () => es.close();
  }, []);
  return frame;
}

function Remote() {
  const { paused } = useControlState();
  const frame = useStreamFrame();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
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

  return (
    <RemotePage>
      <StreamFrame>
        {frame ? <StreamImg src={frame} alt="Live feed" /> : "Waiting for feed"}
      </StreamFrame>
      <StatusRow>
        <StatusDot $paused={paused} />
        {paused ? "Paused" : "Live"}
      </StatusRow>
      <ToggleButton $paused={paused} onClick={toggle}>
        {paused ? "Play" : "Pause"}
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
