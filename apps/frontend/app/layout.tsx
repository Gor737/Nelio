import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { StoreProvider } from "./StoreProvider";

import "./styles/globals.css";
import { AuthBootstrap } from "./components/AuthBootstrap";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
});

interface Props {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: Props) {
  return (
    <StoreProvider>
      <html lang="en" className={jakarta.variable}>
        <body>
          <AuthBootstrap />
          {children}
        </body>
      </html>
    </StoreProvider>
  );
}
