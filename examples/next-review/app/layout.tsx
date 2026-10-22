import type { ReactNode } from "react";

export const metadata = { title: "Review — Overturn example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{ margin: 0, background: "#0f0f11", color: "#e8e8ec", font: "15px/1.5 system-ui, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
