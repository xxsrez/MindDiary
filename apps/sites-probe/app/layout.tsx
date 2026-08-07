import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mind Diary Sites capability probe",
  description: "Non-product OpenAI Sites and MCP capability gate for Mind Diary.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
