// Severity filter chips and a busy state for slow submits. Pages work without JavaScript.
(() => {
  const hidden = new Set();
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-sev]");
    if (!chip) return;
    const sev = chip.dataset.sev;
    if (hidden.has(sev)) hidden.delete(sev);
    else hidden.add(sev);
    chip.classList.toggle("on", !hidden.has(sev));
    document.querySelectorAll("[data-sev]:not(.chip)").forEach((el) => (el.hidden = hidden.has(el.dataset.sev)));
  });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("form[data-busy]");
    if (f) {
      f.classList.add("is-busy");
      f.querySelectorAll("button").forEach((b) => (b.disabled = true));
    }
  });
})();
