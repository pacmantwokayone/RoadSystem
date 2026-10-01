// 2-D cross-section preview of a profile (the thing you see while editing its code).
// `computeProfileView` is pure (testable); `drawProfile` paints it on a canvas.

import { profileHeightAt as profileHeightAtPreview, type ProfileData } from '../profile/types';

export interface ProfileView {
  /** pixels per metre */
  scale: number;
  /** canvas px of lateral x = 0 */
  originX: number;
  /** canvas px of y = 0 (design height) */
  originY: number;
  /** lowest y drawn (bottom of the body), metres */
  bottomY: number;
}

export function computeProfileView(profile: ProfileData, width: number, height: number, pad = 24): ProfileView {
  const half = Math.max(profile.outerHalfWidth, 0.5);
  let minY = 0, maxY = 0;
  for (const p of profile.points) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const bottomY = minY - profile.thickness;
  const spanY = Math.max(maxY - bottomY, 0.5);
  const scale = Math.min((width - 2 * pad) / (2 * half), (height - 2 * pad) / spanY);
  return {
    scale,
    originX: width / 2,
    originY: pad + (maxY + (height - 2 * pad) / scale / 2 - spanY / 2) * scale,
    bottomY,
  };
}

export type ColorOf = (material: string) => string;

export function drawProfile(
  ctx: CanvasRenderingContext2D, profile: ProfileData, width: number, height: number, colorOf: ColorOf, errorText?: string,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101820';
  ctx.fillRect(0, 0, width, height);
  const v = computeProfileView(profile, width, height);
  const X = (x: number): number => v.originX + x * v.scale;
  const Y = (y: number): number => v.originY - y * v.scale;

  // metre grid
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  const halfM = Math.ceil(width / 2 / v.scale);
  ctx.beginPath();
  for (let m = -halfM; m <= halfM; m++) { ctx.moveTo(X(m), 0); ctx.lineTo(X(m), height); }
  ctx.stroke();

  // body: top polyline down to the bottom
  const pts = profile.points;
  ctx.beginPath();
  ctx.moveTo(X(pts[0].x), Y(pts[0].y));
  for (const p of pts) ctx.lineTo(X(p.x), Y(p.y));
  ctx.lineTo(X(pts[pts.length - 1].x), Y(v.bottomY));
  ctx.lineTo(X(pts[0].x), Y(v.bottomY));
  ctx.closePath();
  ctx.fillStyle = colorOf(profile.bodyMaterial);
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;

  // design-height axis and centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, Y(0)); ctx.lineTo(width, Y(0));
  ctx.moveTo(X(0), 0); ctx.lineTo(X(0), height);
  ctx.stroke();
  ctx.setLineDash([]);

  // top surface, one coloured stroke per segment
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  profile.segments.forEach((seg, k) => {
    ctx.strokeStyle = colorOf(seg.material);
    ctx.beginPath();
    ctx.moveTo(X(pts[k].x), Y(pts[k].y));
    ctx.lineTo(X(pts[k + 1].x), Y(pts[k + 1].y));
    ctx.stroke();
  });

  // painted lines: short ticks just above the surface (dashed styles drawn dotted)
  for (const m of profile.markings) {
    const y = profileHeightAtPreview(profile, m.x);
    ctx.fillStyle = m.color === 'yellow' ? '#e8c424' : '#f2f2ee';
    const w = Math.max(2, m.width * v.scale);
    const draw = (x: number): void => ctx.fillRect(X(x) - w / 2, Y(y) - 5, w, 4);
    if (m.style === 'double') { draw(m.x - m.spacing / 2); draw(m.x + m.spacing / 2); } else draw(m.x);
  }

  // points
  ctx.fillStyle = '#e8eef5';
  for (const p of pts) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2); ctx.fill(); }

  // labels
  ctx.fillStyle = '#9fb3c8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${(profile.outerHalfWidth * 2).toFixed(1)} m gesamt · Fahrbahn ${(profile.coreHalfWidth * 2).toFixed(1)} m · Körper ${profile.thickness.toFixed(2)} m`, 8, 6);

  if (errorText) {
    ctx.fillStyle = 'rgba(120,20,20,0.82)';
    ctx.fillRect(0, height - 22, width, 22);
    ctx.fillStyle = '#ffd0d0';
    ctx.textBaseline = 'middle';
    ctx.fillText('Fehler – letzte gültige Version aktiv', 8, height - 11);
  }
}
