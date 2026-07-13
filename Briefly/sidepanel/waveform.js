// Live recording waveform renderer. Owns a single <canvas> and smooths bar
// heights frame-to-frame. Extracted from sidepanel.js to keep that file focused.

export function createWaveform(canvas) {
  const ctx = canvas.getContext('2d');
  let smoothedBars = null;

  function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawIdle() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = themeColor('--border') || '#2a3140';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  }

  function drawBars(bars) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (!smoothedBars || smoothedBars.length !== bars.length) {
      smoothedBars = new Float32Array(bars.length);
    }
    const accent = themeColor('--accent') || '#4f7cff';
    const accentSoft = themeColor('--accent-hover') || accent;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, accentSoft);
    grad.addColorStop(1, accent);
    ctx.fillStyle = grad;
    const barW = W / bars.length;
    const minH = 2;
    for (let i = 0; i < bars.length; i++) {
      smoothedBars[i] = smoothedBars[i] * 0.55 + bars[i] * 0.45;
      const h = Math.max(minH, (smoothedBars[i] / 255) * H * 0.95);
      const x = i * barW + 1;
      const y = (H - h) / 2;
      const w = barW - 2;
      const r = Math.min(w / 2, 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fill();
    }
  }

  function reset() { smoothedBars = null; drawIdle(); }

  window.addEventListener('resize', resize);
  setTimeout(resize, 0);
  drawIdle();

  return { drawBars, drawIdle, reset, resize };
}
