import { toBlob } from "html-to-image";

export async function downloadModalImage(modal: HTMLElement, name: string) {
  await document.fonts.ready;
  await Promise.all(Array.from(modal.querySelectorAll("img"), (image) => image.decode()));

  // Render a separate, expanded copy so scrolling and the live modal stay untouched.
  const copy = modal.cloneNode(true) as HTMLElement;
  copy.classList.add("detail-export");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.style.width = `${modal.getBoundingClientRect().width}px`;
  copy.querySelectorAll("[data-export-exclude]").forEach((element) => element.remove());
  document.body.append(copy);
  try {
    // SVG presentation styles must travel with the standalone image.
    copy.querySelectorAll(".item-box-overlay rect").forEach((rect) => {
      const style = getComputedStyle(rect);
      rect.setAttribute("fill", style.fill);
      rect.setAttribute("stroke", style.stroke);
      rect.setAttribute("stroke-width", style.strokeWidth);
    });
    await Promise.all(Array.from(copy.querySelectorAll("img"), (image) => image.decode()));
    const blob = await toBlob(copy, {
      pixelRatio: 2,
      preferredFontFormat: "woff2",
      backgroundColor: getComputedStyle(modal).backgroundColor,
      style: { position: "static", inset: "auto", margin: "0" },
    });
    if (!blob) throw new Error("Could not create the image. Please try again.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 100) || "yard-sale-find"}.png`;
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } finally {
    copy.remove();
  }
}
