import gsap from "gsap";
import type { Renderer } from "../render/Renderer";

/** Floating in-world text (combos, criticals, misses) and big center banners, as HTML over the canvas. */
export class Popups {
  constructor(
    private root: HTMLElement,
    private renderer: Renderer,
  ) {}

  text(x: number, y: number, html: string, cls = "", opts: { rise?: number; dur?: number; delay?: number } = {}) {
    const p = this.renderer.worldToPixels(x, y);
    const el = document.createElement("div");
    el.className = `popup ${cls}`;
    el.innerHTML = html;
    // keep inside the screen
    const margin = 120;
    el.style.left = `${Math.max(margin, Math.min(this.renderer.width - margin, p.x))}px`;
    el.style.top = `${Math.max(90, Math.min(this.renderer.height - 90, p.y))}px`;
    this.root.appendChild(el);
    const rise = opts.rise ?? 60;
    const dur = opts.dur ?? 1.1;
    const tl = gsap.timeline({ delay: opts.delay ?? 0, onComplete: () => el.remove() });
    tl.fromTo(el, { scale: 0.3, opacity: 0, rotate: -8 }, { scale: 1.08, opacity: 1, rotate: 0, duration: 0.18, ease: "back.out(3)" })
      .to(el, { scale: 1, duration: 0.12 })
      .to(el, { y: -rise, opacity: 0, duration: dur * 0.6, ease: "power2.in" }, `+=${dur * 0.35}`);
  }

  missMark(x: number) {
    const p = this.renderer.worldToPixels(x, 0);
    const el = document.createElement("div");
    el.className = "popup miss";
    el.innerHTML = `<svg viewBox="0 0 40 40" width="46" height="46"><path d="M8 8 L32 32 M32 8 L8 32" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg>`;
    el.style.left = `${Math.max(40, Math.min(this.renderer.width - 40, p.x))}px`;
    el.style.top = `${this.renderer.height - 70}px`;
    this.root.appendChild(el);
    gsap
      .timeline({ onComplete: () => el.remove() })
      .fromTo(el, { scale: 0, opacity: 0 }, { scale: 1.2, opacity: 1, duration: 0.15, ease: "back.out(3)" })
      .to(el, { scale: 1, duration: 0.1 })
      .to(el, { opacity: 0, y: 20, duration: 0.5 }, "+=0.5");
  }

  banner(html: string, cls = "", hold = 0.8) {
    // Only one banner at a time: a new one replaces whatever is showing.
    this.root.querySelectorAll(".banner").forEach((b) => {
      gsap.killTweensOf(b);
      b.remove();
    });
    const el = document.createElement("div");
    el.className = `banner ${cls}`;
    el.innerHTML = html;
    this.root.appendChild(el);
    return gsap
      .timeline({ onComplete: () => el.remove() })
      .fromTo(el, { scale: 2.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.32, ease: "power3.out" })
      .to(el, { scale: 0.92, opacity: 0, duration: 0.3, ease: "power2.in" }, `+=${hold}`);
  }

  clear() {
    this.root.innerHTML = "";
  }
}
