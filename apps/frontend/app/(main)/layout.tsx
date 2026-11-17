import type { ReactNode } from "react";

import { Header } from "../components/Header";

interface Props {
  readonly children: ReactNode;
}

export default function MainLayout({ children }: Props) {
  return (
    <div>
      <Header />
      <main>{children}</main>
    </div>
  );
}
