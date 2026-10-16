import "@fontsource/shojumaru/400.css";
import "@fontsource-variable/outfit";
import "./styles/main.css";
import gsap from "gsap";
import "./render/nanGuard";
import { App } from "./App";

// Keep UI animations on wall-clock time even if a frame is slow.
gsap.ticker.lagSmoothing(0);

const app = new App();

// Dev-only handle for automated browser tests.
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
