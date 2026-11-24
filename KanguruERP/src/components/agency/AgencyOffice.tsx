import { useMemo, type CSSProperties } from 'react';
import type { AgencyRoom } from '../../db/agency';

// Escritorio da Agencia em pixel art isometrico (prototipo aprovado em 2026-11-24).
// Desenhado em 1280x720 e escalado para a largura disponivel.

export interface RoomDef {
  id: AgencyRoom;
  agent: string;
  short: string;
  label: string;
  seat?: [number, number];
  stand?: [number, number];
  walk: number;
  area: [number, number, number, number];
  hair: string;
  skin: string;
  tie: string;
}

export const ROOMS: RoomDef[] = [
  { id: 'recepcao', agent: 'Gerente da Agência', short: 'Gerente', label: 'GERENTE · RECEPÇÃO', seat: [2.15, 1.75], walk: 3.0, area: [0, 0, 4.4, 5.8], hair: '#3f2a1d', skin: '#8d5a3b', tie: '#2563eb' },
  { id: 'marketing', agent: 'Agente de Marketing', short: 'Marketing', label: 'AGENTE DE MARKETING', stand: [7.75, 2.7], walk: 7, area: [5, 0, 3.9, 5.8], hair: '#1c1917', skin: '#c68642', tie: '#db2777' },
  { id: 'vendas', agent: 'Agente de Vendas', short: 'Vendas', label: 'AGENTE DE VENDAS', seat: [13.3, 1.7], walk: 13.4, area: [11.2, 0, 4.8, 5.8], hair: '#78350f', skin: '#f2c9a0', tie: '#16a34a' },
  { id: 'atendimento', agent: 'Agente de Atendimento', short: 'Atendimento', label: 'AGENTE DE ATENDIMENTO', seat: [2.0, 9.5], walk: 2.2, area: [0, 8.2, 4.3, 5.8], hair: '#b45309', skin: '#f2c9a0', tie: '#0891b2' },
  { id: 'compras', agent: 'Agente de Compras', short: 'Compras', label: 'AGENTE DE COMPRAS', seat: [6.9, 9.5], walk: 7, area: [5, 8.2, 3.9, 5.8], hair: '#0c0a09', skin: '#e0ac69', tie: '#7c3aed' },
  { id: 'financeiro', agent: 'Agente Financeiro', short: 'Financeiro', label: 'AGENTE FINANCEIRO', seat: [13.3, 9.6], walk: 13.4, area: [11.2, 8.2, 4.8, 5.8], hair: '#b91c1c', skin: '#f5d0b0', tie: '#d97706' },
];

type Point = [number, number];
interface Shape { points: string; fill: string; stroke?: string; sw?: number }
interface Colors { top: string; left: string; right: string }

const W = 1280;
const H = 720;
const iso = (gx: number, gy: number, z = 0): Point => [640 + (gx - gy) * 32, 100 + (gx + gy) * 16 - z];
const poly = (list: Point[], fill: string, stroke?: string, sw?: number): Shape => ({
  points: list.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
  fill,
  stroke,
  sw,
});

function box(out: Shape[], gx: number, gy: number, w: number, d: number, h: number, z: number, c: Colors) {
  const t = z + h;
  out.push(poly([iso(gx, gy + d, t), iso(gx + w, gy + d, t), iso(gx + w, gy + d, z), iso(gx, gy + d, z)], c.left));
  out.push(poly([iso(gx + w, gy, t), iso(gx + w, gy + d, t), iso(gx + w, gy + d, z), iso(gx + w, gy, z)], c.right));
  out.push(poly([iso(gx, gy, t), iso(gx + w, gy, t), iso(gx + w, gy + d, t), iso(gx, gy + d, t)], c.top));
}

function monitor(out: Shape[], gx: number, gy: number) {
  box(out, gx, gy, 0.55, 0.1, 20, 18, { top: '#2a3442', left: '#132033', right: '#222c3a' });
  for (let k = 0; k < 3; k += 1) {
    const zz = 18 + 20 - 5 - k * 5;
    const a = gx + 0.07;
    const b = gx + 0.55 * (k === 1 ? 0.55 : 0.8);
    out.push(poly([iso(a, gy + 0.1, zz), iso(b, gy + 0.1, zz), iso(b, gy + 0.1, zz - 2), iso(a, gy + 0.1, zz - 2)], '#4ade80'));
  }
}

const STANDING = [
  '...hhhh...',
  '..hhhhhh..',
  '..hssssh..',
  '..ssssss..',
  '..sessse..',
  '...ssss...',
  '..bbwwbb..',
  '.bbbwtbbb.',
  '.bbbwtbbb.',
  '.bbbbbbbb.',
  '.sbbbbbbs.',
  '..bbbbbb..',
  '..pp..pp..',
  '..pp..pp..',
  '..pp..pp..',
  '.kkk..kkk.',
];
const SEATED = STANDING.slice(0, 12);

const palette = (hair: string, skin: string, tie: string, suit = '#2a3040'): Record<string, string> =>
  ({ h: hair, s: skin, e: '#1a1a1a', b: suit, w: '#e5e7eb', t: tie, p: '#1f2430', k: '#0b0d12' });

function sprite(out: Shape[], sx: number, sy: number, rows: string[], pal: Record<string, string>, scale: number) {
  const w = rows[0].length;
  const x0 = sx - (w * scale) / 2;
  const y0 = sy - rows.length * scale;
  rows.forEach((row, r) => {
    let c = 0;
    while (c < w) {
      const ch = row[c];
      if (ch === '.') { c += 1; continue; }
      let e = c;
      while (e < w && row[e] === ch) e += 1;
      const x = x0 + c * scale;
      const y = y0 + r * scale;
      const x2 = x0 + e * scale;
      const y2 = y + scale;
      out.push({ points: `${x},${y} ${x2},${y} ${x2},${y2} ${x},${y2}`, fill: pal[ch] });
      c = e;
    }
  });
}

function buildScene(selected: AgencyRoom | null): Shape[] {
  const out: Shape[] = [];
  const C: Record<string, Colors> = {
    desk: { top: '#c8763a', left: '#9c5526', right: '#7d421d' },
    boss: { top: '#a8582a', left: '#7e3f1c', right: '#653317' },
    part: { top: '#d3e3df', left: '#a3bdb6', right: '#8aa59e' },
    chair: { top: '#3a4f7a', left: '#24324f', right: '#1c2840' },
    cab: { top: '#b0b9c2', left: '#7d8893', right: '#66707b' },
    board: { top: '#e5e7eb', left: '#f8fafc', right: '#cbd5e1' },
    plant: { top: '#22c55e', left: '#15803d', right: '#166534' },
    pot: { top: '#92400e', left: '#78350f', right: '#5b280b' },
    pc: { top: '#3b4656', left: '#222c3a', right: '#1a2230' },
    carton: { top: '#d6a46a', left: '#b07d45', right: '#946535' },
  };
  const WALL = 78;

  // Paredes do fundo
  out.push(poly([iso(0, 0), iso(0, 14), iso(0, 14, WALL), iso(0, 0, WALL)], '#9fbfb4'));
  out.push(poly([iso(0, 0), iso(16, 0), iso(16, 0, WALL), iso(0, 0, WALL)], '#b5d3c7'));
  out.push(poly([iso(0, 0), iso(0, 14), iso(0, 14, 7), iso(0, 0, 7)], '#6f8c84'));
  out.push(poly([iso(0, 0), iso(16, 0), iso(16, 0, 7), iso(0, 0, 7)], '#7f9c94'));
  out.push(poly([iso(0, 0, WALL), iso(0, 14, WALL), iso(0, 14, WALL + 6), iso(0, 0, WALL + 6)], '#56746c'));
  out.push(poly([iso(0, 0, WALL), iso(16, 0, WALL), iso(16, 0, WALL + 6), iso(0, 0, WALL + 6)], '#5f7d75'));
  [3.5, 7.5, 11.5].forEach(gx => {
    out.push(poly([iso(gx, 0, 24), iso(gx + 2.2, 0, 24), iso(gx + 2.2, 0, 62), iso(gx, 0, 62)], '#5b7fa8'));
    out.push(poly([iso(gx + 0.1, 0, 27), iso(gx + 2.1, 0, 27), iso(gx + 2.1, 0, 59), iso(gx + 0.1, 0, 59)], '#9cc4e4'));
  });

  // Piso
  for (let gx = 0; gx < 16; gx += 1) {
    for (let gy = 0; gy < 14; gy += 1) {
      const alt = (gx + gy) % 2 === 0;
      let fill = alt ? '#8c919b' : '#969ba5';
      if (gy === 6 || gy === 7 || gx === 9 || gx === 10) fill = alt ? '#33456b' : '#3a4e78';
      else if (gx <= 3 && gy <= 5) fill = alt ? '#4a4791' : '#524f9b';
      out.push(poly([iso(gx, gy), iso(gx + 1, gy), iso(gx + 1, gy + 1), iso(gx, gy + 1)], fill, '#7b808a', 0.6));
    }
  }
  out.push(poly([iso(0, 6.94, 0.3), iso(16, 6.94, 0.3), iso(16, 7.06, 0.3), iso(0, 7.06, 0.3)], '#5d76a8'));
  out.push(poly([iso(9.94, 0, 0.3), iso(10.06, 0, 0.3), iso(10.06, 14, 0.3), iso(9.94, 14, 0.3)], '#5d76a8'));

  // Estacao escolhida
  const sel = ROOMS.find(room => room.id === selected);
  if (sel) {
    const [ax, ay, aw, ad] = sel.area;
    out.push(poly([iso(ax, ay, 0.5), iso(ax + aw, ay, 0.5), iso(ax + aw, ay + ad, 0.5), iso(ax, ay + ad, 0.5)], 'rgba(250,204,21,0.14)', '#facc15', 2));
  }

  const people = Object.fromEntries(ROOMS.map(room => [room.id, palette(room.hair, room.skin, room.tie)])) as Record<AgencyRoom, Record<string, string>>;
  const seat = (id: AgencyRoom, gx: number, gy: number) => { const p = iso(gx, gy, 14); sprite(out, p[0], p[1], SEATED, people[id], 3); };

  // Gerente
  box(out, 0.3, 0.3, 0.4, 0.4, 10, 0, C.pot);
  box(out, 0.22, 0.22, 0.56, 0.56, 22, 10, C.plant);
  box(out, 1.85, 1.2, 0.6, 0.55, 26, 0, C.chair);
  seat('recepcao', 2.15, 1.75);
  box(out, 1.0, 2.3, 2.4, 1.0, 18, 0, C.boss);
  monitor(out, 2.55, 2.4);
  box(out, 1.3, 4.1, 0.5, 0.5, 14, 0, C.boss);
  box(out, 2.5, 4.1, 0.5, 0.5, 14, 0, C.boss);

  // Marketing
  box(out, 5.7, 1.0, 0.08, 0.12, 14, 0, C.cab);
  box(out, 7.9, 1.0, 0.08, 0.12, 14, 0, C.cab);
  box(out, 5.6, 1.0, 2.4, 0.12, 46, 14, C.board);
  ([['#facc15', 5.85, 52], ['#f472b6', 6.35, 52], ['#4ade80', 6.85, 50], ['#60a5fa', 5.95, 38], ['#facc15', 6.6, 36]] as const).forEach(([color, gx, z]) => {
    out.push(poly([iso(gx, 1.12, z), iso(gx + 0.3, 1.12, z), iso(gx + 0.3, 1.12, z - 9), iso(gx, 1.12, z - 9)], color));
  });
  out.push(poly([iso(7.2, 1.12, 50), iso(7.8, 1.12, 50), iso(7.8, 1.12, 48), iso(7.2, 1.12, 48)], '#475569'));
  out.push(poly([iso(7.2, 1.12, 44), iso(7.7, 1.12, 44), iso(7.7, 1.12, 42), iso(7.2, 1.12, 42)], '#475569'));
  { const p = iso(7.75, 2.7); sprite(out, p[0], p[1], STANDING, people.marketing, 3); }
  box(out, 5.4, 3.4, 1.9, 0.9, 18, 0, C.desk);
  monitor(out, 5.9, 3.5);
  box(out, 6.0, 4.5, 0.5, 0.5, 18, 0, C.chair);
  box(out, 5.1, 5.6, 3.7, 0.12, 30, 0, C.part);

  // Vendas
  box(out, 11.3, 0.4, 0.12, 5.2, 30, 0, C.part);
  box(out, 15.2, 0.4, 0.6, 0.6, 40, 0, C.cab);
  box(out, 13.0, 1.15, 0.55, 0.55, 26, 0, C.chair);
  seat('vendas', 13.3, 1.7);
  box(out, 12.0, 2.2, 2.6, 1.0, 18, 0, C.desk);
  monitor(out, 12.5, 2.3);
  monitor(out, 13.5, 2.3);
  box(out, 14.8, 2.4, 0.35, 0.6, 26, 0, C.pc);
  box(out, 11.4, 5.6, 4.4, 0.12, 30, 0, C.part);

  // Atendimento
  box(out, 0.2, 8.3, 3.9, 0.12, 30, 0, C.part);
  box(out, 1.7, 9.0, 0.55, 0.55, 26, 0, C.chair);
  seat('atendimento', 2.0, 9.5);
  box(out, 0.8, 10.0, 2.4, 1.0, 18, 0, C.desk);
  monitor(out, 1.3, 10.1);
  monitor(out, 2.2, 10.1);
  box(out, 0.4, 12.6, 0.4, 0.4, 10, 0, C.pot);
  box(out, 0.32, 12.52, 0.56, 0.56, 22, 10, C.plant);
  box(out, 4.2, 8.3, 0.12, 5.4, 30, 0, C.part);

  // Compras
  box(out, 5.1, 8.3, 3.7, 0.12, 30, 0, C.part);
  box(out, 6.6, 9.0, 0.55, 0.55, 26, 0, C.chair);
  seat('compras', 6.9, 9.5);
  box(out, 5.6, 10.0, 2.4, 1.0, 18, 0, C.desk);
  monitor(out, 6.1, 10.1);
  monitor(out, 7.0, 10.1);
  box(out, 5.4, 12.3, 0.7, 0.7, 16, 0, C.carton);
  box(out, 5.5, 12.4, 0.5, 0.5, 12, 16, C.carton);
  box(out, 6.3, 12.5, 0.6, 0.6, 14, 0, C.carton);
  box(out, 8.9, 8.3, 0.12, 5.4, 30, 0, C.part);

  // Financeiro
  box(out, 11.3, 8.3, 0.12, 5.4, 30, 0, C.part);
  box(out, 11.4, 8.3, 4.4, 0.12, 30, 0, C.part);
  box(out, 15.1, 8.6, 0.7, 0.6, 44, 0, C.cab);
  box(out, 15.1, 9.3, 0.7, 0.6, 44, 0, C.cab);
  box(out, 13.0, 9.1, 0.55, 0.55, 26, 0, C.chair);
  seat('financeiro', 13.3, 9.6);
  box(out, 12.0, 10.1, 2.6, 1.0, 18, 0, C.desk);
  monitor(out, 12.6, 10.2);
  monitor(out, 13.6, 10.2);
  box(out, 15.3, 12.6, 0.4, 0.4, 10, 0, C.pot);
  box(out, 15.22, 12.52, 0.56, 0.56, 22, 10, C.plant);

  return out;
}

const USER_SPRITE: Shape[] = (() => {
  const out: Shape[] = [];
  sprite(out, 15, 48, STANDING, palette('#3f2a1d', '#e0ac7e', '#f97316', '#374151'), 3);
  return out;
})();

export type RoomState = 'DISPONIVEL' | 'EM_CONVERSA' | 'PENSANDO' | 'SEM_ACESSO';

const STATE_LOOK: Record<RoomState, { text: string; color: string; bg: string; border: string }> = {
  DISPONIVEL: { text: 'DISPONÍVEL', color: '#86efac', bg: '#0f2a1c', border: '#2f6b47' },
  EM_CONVERSA: { text: 'EM CONVERSA', color: '#fde047', bg: '#2b260c', border: '#a16207' },
  PENSANDO: { text: 'PENSANDO...', color: '#93c5fd', bg: '#0c1a33', border: '#1d4ed8' },
  SEM_ACESSO: { text: 'SEM ACESSO', color: '#94a3b8', bg: '#151c28', border: '#334155' },
};

// Medidas do desenho (1280 px de largura) convertidas para a largura real do quadro.
const cq = (px: number) => `calc(${px} / ${W} * 100cqw)`;
const pctX = (x: number) => `${(x / W) * 100}%`;
const pctY = (y: number) => `${(y / H) * 100}%`;

interface Props {
  selected: AgencyRoom | null;
  states: Record<AgencyRoom, RoomState>;
  onSelect: (room: AgencyRoom) => void;
  panel: { used: number; limit: number; status: string; statusColor: string };
}

export default function AgencyOffice({ selected, states, onSelect, panel }: Props) {
  const shapes = useMemo(() => buildScene(selected), [selected]);
  const current = ROOMS.find(room => room.id === selected);
  const target = iso(current?.walk ?? 9.5, 7);

  const labels = ROOMS.map(room => {
    let x: number;
    let y: number;
    if (room.stand) { const p = iso(room.stand[0], room.stand[1]); x = p[0]; y = p[1] - 54; }
    else { const p = iso(room.seat![0], room.seat![1], 14); x = p[0]; y = p[1] - 42; }
    return { room, x, y, look: STATE_LOOK[states[room.id]] };
  });

  const hotspots = ROOMS.map(room => {
    const [ax, ay, aw, ad] = room.area;
    const pts = [iso(ax, ay, 60), iso(ax + aw, ay), iso(ax + aw, ay + ad), iso(ax, ay + ad), iso(ax, ay)];
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const left = Math.min(...xs) + 24;
    const right = Math.max(...xs) - 24;
    const top = Math.min(...ys);
    const bottom = Math.max(...ys) - 10;
    return { room, left, top, width: right - left, height: bottom - top };
  });

  const textStyle = (px: number, extra: CSSProperties = {}): CSSProperties => ({ fontSize: cq(px), ...extra });

  return (
    <div
      className="relative w-full overflow-hidden rounded-xl border border-slate-800 select-none"
      style={{ aspectRatio: `${W} / ${H}`, background: '#131a29', containerType: 'inline-size', fontFamily: "'Pixelify Sans', ui-monospace, monospace", color: '#e2e8f0' }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" shapeRendering="crispEdges" aria-hidden="true">
        {shapes.map((shape, index) => (
          <polygon key={index} points={shape.points} fill={shape.fill} stroke={shape.stroke ?? 'none'} strokeWidth={shape.sw ?? 0} />
        ))}
      </svg>

      <span className="absolute text-center font-semibold" style={{ left: pctX(440), top: pctY(85), width: pctX(150), padding: `${cq(5)} 0`, transform: 'skewY(-26.57deg)', background: '#1d2b3f', border: '2px solid #4b6383', color: '#dbe7f3', letterSpacing: '0.06em', ...textStyle(13) }}>
        SALA DO GERENTE
      </span>
      <span className="absolute text-center font-bold" style={{ left: pctX(878), top: pctY(176), width: pctX(190), padding: `${cq(6)} 0`, transform: 'skewY(26.57deg)', background: '#1d2b3f', border: '2px solid #4b6383', color: '#dbe7f3', letterSpacing: '0.08em', ...textStyle(15) }}>
        AGÊNCIA <span style={{ color: '#fb923c' }}>KANGURU</span>
      </span>

      {hotspots.map(({ room, left, top, width, height }) => (
        <button
          key={room.id}
          type="button"
          onClick={() => onSelect(room.id)}
          aria-label={`Conversar com ${room.agent}`}
          className="absolute cursor-pointer border-2 border-dashed border-transparent hover:border-yellow-300/75 focus-visible:border-yellow-300 outline-none"
          style={{ left: pctX(left), top: pctY(top), width: pctX(width), height: pctY(height), background: 'transparent' }}
        />
      ))}

      {labels.map(({ room, x, y, look }) => (
        <span key={room.id} className="pointer-events-none absolute flex flex-col items-center" style={{ left: pctX(x), top: pctY(y), transform: 'translate(-50%, -100%)', gap: cq(4) }}>
          <span className="whitespace-nowrap font-bold" style={{ padding: `${cq(3)} ${cq(7)}`, background: look.bg, border: `2px solid ${look.border}`, color: look.color, letterSpacing: '0.06em', ...textStyle(12) }}>{look.text}</span>
          <span className="whitespace-nowrap font-semibold" style={{ padding: `${cq(3)} ${cq(7)}`, background: '#0b1220', border: '2px solid #3d4f6b', color: '#f1f5f9', letterSpacing: '0.05em', ...textStyle(12) }}>{room.label}</span>
        </span>
      ))}

      <span className="pointer-events-none absolute" style={{ left: pctX(target[0] - 15), top: pctY(target[1] - 48), width: pctX(30), height: pctY(48), transition: 'left 1.1s linear, top 1.1s linear' }}>
        <span className="absolute text-center font-bold" style={{ left: '-37%', top: '-46%', width: '174%', background: '#f97316', color: '#131a29', border: '2px solid #7c2d12', ...textStyle(11) }}>VOCÊ</span>
        <svg viewBox="0 0 30 48" className="h-full w-full" shapeRendering="crispEdges" aria-hidden="true">
          {USER_SPRITE.map((shape, index) => <polygon key={index} points={shape.points} fill={shape.fill} />)}
        </svg>
      </span>

      <section aria-label="Painel de controle" className="absolute flex flex-col" style={{ left: pctX(964), top: pctY(566), width: pctX(296), background: 'rgba(13,22,38,0.94)', border: '2px solid #5ea2c9', boxShadow: '4px 4px 0 #070b14', padding: `${cq(10)} ${cq(14)}`, gap: cq(6), letterSpacing: '0.05em', ...textStyle(15) }}>
        <span className="font-bold" style={{ color: '#a5d8f3', borderBottom: '2px solid #2d4c66', paddingBottom: cq(6) }}>PAINEL DE CONTROLE</span>
        <span className="flex justify-between" style={{ color: '#dbeafe' }}>AGENTES: <span style={{ color: '#ffffff' }}>{ROOMS.filter(room => states[room.id] !== 'SEM_ACESSO').length}</span></span>
        <span className="flex justify-between" style={{ color: '#dbeafe' }}>PERGUNTAS NO MÊS: <span style={{ color: '#ffffff' }}>{panel.used}/{panel.limit}</span></span>
        <span className="flex justify-between" style={{ color: '#dbeafe' }}>ESTADO: <span style={{ color: panel.statusColor }}>{panel.status}</span></span>
      </section>

      <span className="pointer-events-none absolute" style={{ left: pctX(20), bottom: pctY(16), color: '#94a3b8', letterSpacing: '0.04em', ...textStyle(13) }}>
        Clique numa estação para chamar o agente
      </span>
    </div>
  );
}
