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

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);
  const [description, setDescription] = useState("");

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

  return (
    <Page>
      <Video ref={videoRef} autoPlay playsInline muted />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {description && <Overlay>{description}</Overlay>}
      {error && <Message>{error}</Message>}
    </Page>
  );
}

export default App;
