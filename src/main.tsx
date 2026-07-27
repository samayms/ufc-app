import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import {
  applyFontVariant,
  FontReviewControls,
  fontVariantFromSearch,
} from "./ui/FontReview.tsx";
import "./index.css";

applyFontVariant(fontVariantFromSearch(window.location.search));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <FontReviewControls />
  </StrictMode>,
);
