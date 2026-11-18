import type { ReactNode } from "react";

import { Header } from "../components/Header";
import { SocketBootstrap } from "../components/SocketBootstrap";

interface Props {
  readonly children: ReactNode;
}

export default function MainLayout({ children }: Props) {
  return (
    <div>
      <SocketBootstrap />
      <Header />
      <main>{children}</main>
    </div>
  );
}
