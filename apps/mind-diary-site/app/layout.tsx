import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mind Diary",
  description: "A private-by-default home for shared, versioned knowledge.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
