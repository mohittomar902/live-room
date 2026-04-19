import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Live Room",
  description: "Two-person video, chat, screen share, and watch-together rooms."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
