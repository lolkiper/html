'use strict';

/** Лёгкий след курсора и волосы персонажа. Слой не перехватывает клики. */

const canvas = document.getElementById('cursor-trail');
const hair = document.getElementById('mascot-hair');
if (canvas && hair) {
  const ctx = canvas.getContext('2d');
  const points = [];
  let mx = window.innerWidth - 80;
  let my = window.innerHeight - 40;
  let tilt = 0;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  window.addEventListener('mousemove', (event) => {
    const dx = event.clientX - mx;
    const dy = event.clientY - my;
    mx = event.clientX;
    my = event.clientY;
    tilt += (Math.max(-18, Math.min(18, dx * 0.35)) - tilt) * 0.35;
    hair.style.transform = `rotate(${tilt}deg) translate(${dx * 0.04}px, ${dy * 0.02}px)`;
    points.push({ x: mx, y: my, life: 1 });
    if (points.length > 28) points.shift();
  });

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length > 1) {
      ctx.lineCap = 'round';
      for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const point = points[i];
        point.life *= 0.92;
        ctx.strokeStyle = `rgba(240, 183, 201, ${point.life * 0.55})`;
        ctx.lineWidth = point.life * 3.2;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      while (points.length && points[0].life < 0.04) points.shift();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
