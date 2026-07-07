import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(160deg, #0b1633, #1f3a8a)",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#88a5e6",
          }}
        >
          AI BackOffice
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 60,
            fontWeight: 800,
            color: "#fff",
            lineHeight: 1.15,
            maxWidth: 920,
          }}
        >
          Every missed call is a job your competitor just booked.
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 32,
            fontSize: 28,
            color: "#c9d6f5",
          }}
        >
          Automated missed-call recovery for home service contractors
        </div>
      </div>
    ),
    { ...size }
  );
}
