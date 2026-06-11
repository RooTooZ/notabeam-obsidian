export type Hlc = string;

export type HlcParts = { millis: number; counter: number; node: string };

const MILLIS_WIDTH = 15;
const COUNTER_WIDTH = 6;

export const encodeHlc = ({ millis, counter, node }: HlcParts): Hlc =>
  `${String(millis).padStart(MILLIS_WIDTH, "0")}:${String(counter).padStart(COUNTER_WIDTH, "0")}:${node}`;

export const compareHlc = (a: Hlc, b: Hlc): number => (a < b ? -1 : a > b ? 1 : 0);

const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1;

export const nextHlc = (prev: Hlc | null, nowMillis: number, node: string): Hlc => {
  const rawMillis = prev ? Number(prev.slice(0, MILLIS_WIDTH)) : 0;
  const rawCounter = prev
    ? Number(prev.slice(MILLIS_WIDTH + 1, MILLIS_WIDTH + 1 + COUNTER_WIDTH))
    : 0;
  // самолечение отравленных/битых часов (NaN из нечислового prev)
  const prevMillis = Number.isFinite(rawMillis) ? rawMillis : 0;
  const prevCounter = Number.isFinite(rawCounter) ? rawCounter : 0;
  if (nowMillis > prevMillis) return encodeHlc({ millis: nowMillis, counter: 0, node });
  // переполнение счётчика (>6 знаков сломало бы лексикографический порядок) → сдвигаем millis
  if (prevCounter >= MAX_COUNTER) return encodeHlc({ millis: prevMillis + 1, counter: 0, node });
  return encodeHlc({ millis: prevMillis, counter: prevCounter + 1, node });
};
