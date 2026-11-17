import type { Metadata } from "next";
import { Catalog } from "./(components)/Catalog";

export default function IndexPage() {
    return(
        <Catalog />
    )
}

export const metadata: Metadata = {
  title: "Nelio",
};
