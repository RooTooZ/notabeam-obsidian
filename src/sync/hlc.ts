import { nextHlc, type Hlc } from "@notabeam/shared";

export type Clock = { now: () => number };

export type HlcGen = {
  next: () => Hlc;
  observe: (hlc: Hlc) => void;
};

export const createHlcGenerator = (opts: {
  node: string;
  clock: Clock;
  load: () => Hlc | null;
  save: (hlc: Hlc) => void;
}): HlcGen => ({
  next: () => {
    const hlc = nextHlc(opts.load(), opts.clock.now(), opts.node);
    opts.save(hlc);
    return hlc;
  },
  observe: (hlc) => {
    const prev = opts.load();
    if (!prev || hlc > prev) opts.save(hlc);
  },
});
