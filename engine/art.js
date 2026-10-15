// Original camera miniatures drawn with Canvas2D (same designs as the native apps; 100x100 units).
const hex = (argb) => {
  const a = ((argb >>> 24) & 255) / 255, r = (argb >>> 16) & 255, g = (argb >>> 8) & 255, b = argb & 255;
  return `rgba(${r},${g},${b},${a})`;
};

export function drawCamera(ctx, category, size) {
  const s = size / 100;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.scale(s, s);
  const rr = (l, t, r, b, rad) => { ctx.beginPath(); ctx.roundRect(l, t, r - l, b - t, rad); };
  const vgrad = (top, bottom, t, b) => { const g = ctx.createLinearGradient(0, t, 0, b); g.addColorStop(0, hex(top)); g.addColorStop(1, hex(bottom)); return g; };
  const body = (l, t, r, b, rad, top, bottom) => {
    rr(l, t, r, b, rad); ctx.fillStyle = vgrad(top, bottom, t, b); ctx.fill();
    ctx.strokeStyle = hex(0x55000000); ctx.lineWidth = 1.2; ctx.stroke();
  };
  const box = (l, t, r, b, rad, c) => { rr(l, t, r, b, rad); ctx.fillStyle = hex(c); ctx.fill(); };
  const dot = (x, y, r, c) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = typeof c === 'number' ? hex(c) : c; ctx.fill(); };
  const ring = (x, y, r, c) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = hex(c); ctx.lineWidth = 1.2; ctx.stroke(); };
  const lens = (x, y, rad, ringC = 0xFF2B2A28) => {
    dot(x, y, rad, ringC); dot(x, y, rad * 0.72, 0xFF0B0D12); dot(x, y, rad * 0.45, 0xFF27324A);
    dot(x - rad * 0.22, y - rad * 0.22, rad * 0.12, 0x99FFFFFF); ring(x, y, rad * 0.86, 0x66FFFFFF);
  };
  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  switch (category) {
    case 'film35': case 'compact':
      body(10, 30, 90, 74, 7, 0xFF3B3835, 0xFF1E1C1A); box(10, 30, 90, 40, 4, 0xFFB8B2A8);
      box(16, 33, 30, 38, 1.5, 0xFF20252E); box(70, 33, 84, 38, 1.5, 0xFFE9E4D8); lens(56, 57, 15);
      if (category === 'compact') dot(22, 50, 2.5, 0xFFF2A93B);
      break;
    case 'disposable':
      body(10, 28, 90, 76, 6, 0xFFF4C430, 0xFFE3A21A); box(10, 52, 90, 66, 0, 0xFF1F6F43);
      box(66, 32, 86, 42, 2, 0xFFF3F1EA); lens(40, 48, 11, 0xFF333333); box(14, 32, 26, 39, 1.5, 0xFF20252E);
      break;
    case 'slide':
      box(22, 20, 82, 80, 6, 0xFFE9E5DC); rr(34, 38, 70, 62, 2); ctx.fillStyle = vgrad(0xFF3B79C9, 0xFFE7A33B, 36, 64); ctx.fill();
      box(14, 28, 74, 88, 6, 0x33000000);
      break;
    case 'bw':
      body(10, 30, 90, 74, 7, 0xFF2A2A2A, 0xFF0F0F0F); box(38, 18, 62, 32, 3, 0xFF1A1A1A);
      box(10, 30, 90, 38, 3, 0xFFD9D9D9); lens(50, 56, 15, 0xFF3A3A3A); ring(50, 56, 15, 0xFFFFFFFF);
      break;
    case 'film120':
      body(26, 14, 74, 88, 6, 0xFF2C2B29, 0xFF151413); box(26, 14, 74, 22, 3, 0xFFB8B2A8);
      lens(50, 38, 11); lens(50, 67, 13); box(30, 50, 70, 53, 1, 0xFF8A847A);
      break;
    case 'toy':
      body(14, 22, 86, 80, 10, 0xFF2E8C8C, 0xFF1F6A6A); box(14, 22, 86, 32, 5, 0xFFE24E3B);
      lens(50, 54, 19, 0xFF262626); box(20, 26, 32, 30, 1, 0xFFF4F0E6);
      break;
    case 'halfframe':
      body(22, 18, 78, 84, 7, 0xFFC9C3B8, 0xFF8F897F); box(22, 18, 78, 30, 4, 0xFF2A2826);
      lens(50, 58, 14); box(28, 21, 40, 27, 1.5, 0xFF20252E);
      break;
    case 'instant': {
      body(14, 16, 86, 86, 9, 0xFFF3F0E8, 0xFFD8D3C7);
      [0xFFE5483A, 0xFFF2A93B, 0xFFF4D23C, 0xFF4CAF6E, 0xFF3B79C9].forEach((c, i) => box(47 + i * 3.4, 16, 50.4 + i * 3.4, 86, 0, c));
      lens(36, 46, 15); box(22, 74, 78, 80, 2, 0xFF1D1C1A); box(66, 24, 80, 34, 2, 0xFF20252E);
      break;
    }
    case 'stereo3d':
      body(6, 32, 94, 72, 7, 0xFF3A3632, 0xFF1B1917);
      for (let i = 0; i < 4; i++) lens(20 + i * 20, 54, 7.5);
      box(6, 32, 94, 40, 4, 0xFFB8B2A8);
      break;
    case 'ccd':
      body(12, 30, 88, 72, 9, 0xFFDAD9D6, 0xFF9C9B98); lens(64, 52, 12, 0xFF7E7D7A);
      box(18, 36, 30, 42, 2, 0xFFF4F2EE); dot(84, 34, 1.8, 0xFF2F80ED); box(60, 26, 76, 30, 1, 0xFF8A8986);
      break;
    case 'fisheye': {
      body(12, 30, 88, 76, 9, 0xFF7B3FA0, 0xFF4B2366); dot(50, 56, 21, 0xFF1A1A1A);
      const g = ctx.createLinearGradient(30, 36, 70, 76); g.addColorStop(0, hex(0xFF6EC1E4)); g.addColorStop(1, hex(0xFF0E1630));
      dot(50, 56, 16, g); dot(44, 49, 3, 0xAAFFFFFF);
      break;
    }
    case 'video8':
      poly([[16, 30], [72, 30], [72, 60], [48, 60], [44, 86], [32, 86], [34, 60], [16, 60]], vgrad(0xFF4A4642, 0xFF1E1C1A, 30, 86));
      box(72, 36, 92, 54, 3, 0xFF262524); lens(88, 45, 8); box(16, 22, 40, 30, 2, 0xFFB8B2A8);
      break;
    case 'video16': case 'cinema':
      body(18, 40, 78, 78, 5, 0xFF3A3A3A, 0xFF161616); dot(34, 30, 14, 0xFF262626); dot(62, 30, 14, 0xFF262626);
      ring(34, 30, 9, 0xFF777777); ring(62, 30, 9, 0xFF777777); box(78, 50, 92, 68, 3, 0xFF262524); lens(90, 59, 7);
      break;
    case 'vhs': case 'dv': {
      const v = category === 'vhs';
      body(10, 34, 76, 76, 9, v ? 0xFF2D2D2F : 0xFF8D8F94, v ? 0xFF121214 : 0xFF55575C);
      box(76, 42, 94, 68, 4, 0xFF1C1C1E); lens(88, 55, 9);
      box(16, 40, 46, 50, 2, v ? 0xFFE5483A : 0xFF2F80ED); box(22, 24, 50, 34, 3, 0xFF3A3A3D);
      break;
    }
    case 'projector': {
      body(10, 40, 74, 78, 8, 0xFFC7BFAE, 0xFF8D8574);
      const g = ctx.createLinearGradient(74, 59, 98, 59); g.addColorStop(0, hex(0x99FFE7A8)); g.addColorStop(1, hex(0x00FFE7A8));
      poly([[76, 52], [100, 36], [100, 82], [76, 66]], g); lens(74, 59, 8); box(20, 30, 50, 40, 2, 0xFF3A3632);
      break;
    }
    default:
      body(10, 30, 90, 74, 7, 0xFF3B3835, 0xFF1E1C1A); lens(50, 52, 15);
  }
  ctx.restore();
}
