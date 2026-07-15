import { Main } from "@/main";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")! /* TODO: */);

root.render(
  <StrictMode>
    <Main />
  </StrictMode>,
);
