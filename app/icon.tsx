import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(160deg, #0b1633, #1f3a8a)",
          borderRadius: 14,
        }}
      >
        <span
          style={{
            fontSize: 34,
            fontWeight: 800,
            color: "#fff",
            fontFamily: "sans-serif",
            letterSpacing: -1,
          }}
        >
          A
        </span>
      </div>
    ),
    { ...size }
  );
}
